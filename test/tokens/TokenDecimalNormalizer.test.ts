import { expect } from "chai";
import hre from "hardhat";

/**
 * Tests for TokenDecimalNormalizer.
 *
 * Covers:
 *   - Admin registration and authorization
 *   - Config lookup and unknown-config reverts
 *   - `normalize`: scale-up, scale-down exact, scale-down with precision loss
 *   - `normalizeDown`: truncation and residual reporting
 *   - `isExactlyRepresentable`
 *   - `normalizeForRoute` convenience view
 *   - Overflow guard on scale-up
 *   - Invalid decimal counts
 *   - Ownership transfer
 */
describe("TokenDecimalNormalizer", () => {
  let ethers: any;

  before(async () => {
    const connection = await hre.network.create();
    ethers = connection.ethers;
  });

  // -------------------------------------------------------------------------
  // Deployment helper
  // -------------------------------------------------------------------------
  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("TokenDecimalNormalizer");
    const normalizer = await Factory.deploy(owner.address);
    await normalizer.waitForDeployment();
    return { normalizer, owner, other };
  }

  // Encode a token symbol as a padded bytes32 identifier (simulating
  // keccak256(symbol) for test legibility)
  function tokenId(symbol: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(symbol));
  }

  const STELLAR_CHAIN_ID = 100;  // fictional test chain ID for Stellar
  const ETH_CHAIN_ID     = 1;
  const POLYGON_CHAIN_ID = 137;

  const USDC_ID = tokenId("USDC");
  const WETH_ID = tokenId("WETH");

  // -------------------------------------------------------------------------
  // Deployment
  // -------------------------------------------------------------------------
  describe("deployment", () => {
    it("sets the owner correctly", async () => {
      const { normalizer, owner } = await deploy();
      expect(await normalizer.owner()).to.equal(owner.address);
    });

    it("reverts when constructed with the zero address", async () => {
      const Factory = await ethers.getContractFactory("TokenDecimalNormalizer");
      await expect(
        Factory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("TokenDecimalNormalizer: zero owner");
    });
  });

  // -------------------------------------------------------------------------
  // registerDecimalConfig
  // -------------------------------------------------------------------------
  describe("registerDecimalConfig", () => {
    it("lets the owner register a new config and emits DecimalConfigRegistered", async () => {
      const { normalizer, owner } = await deploy();

      await expect(
        normalizer.connect(owner).registerDecimalConfig(STELLAR_CHAIN_ID, USDC_ID, 7)
      )
        .to.emit(normalizer, "DecimalConfigRegistered")
        .withArgs(STELLAR_CHAIN_ID, USDC_ID, 7);

      expect(await normalizer.getDecimals(STELLAR_CHAIN_ID, USDC_ID)).to.equal(7);
    });

    it("lets the owner overwrite an existing config", async () => {
      const { normalizer, owner } = await deploy();

      await normalizer.connect(owner).registerDecimalConfig(ETH_CHAIN_ID, USDC_ID, 6);
      await normalizer.connect(owner).registerDecimalConfig(ETH_CHAIN_ID, USDC_ID, 8);

      expect(await normalizer.getDecimals(ETH_CHAIN_ID, USDC_ID)).to.equal(8);
    });

    it("reverts when a non-owner calls registerDecimalConfig", async () => {
      const { normalizer, other } = await deploy();

      await expect(
        normalizer.connect(other).registerDecimalConfig(ETH_CHAIN_ID, USDC_ID, 6)
      ).to.be.revertedWithCustomError(normalizer, "Unauthorized");
    });

    it("reverts when decimals exceeds 38", async () => {
      const { normalizer, owner } = await deploy();

      await expect(
        normalizer.connect(owner).registerDecimalConfig(ETH_CHAIN_ID, USDC_ID, 39)
      ).to.be.revertedWithCustomError(normalizer, "InvalidDecimals");
    });

    it("allows registering 0 decimals (whole-unit tokens)", async () => {
      const { normalizer, owner } = await deploy();

      await normalizer.connect(owner).registerDecimalConfig(ETH_CHAIN_ID, USDC_ID, 0);
      expect(await normalizer.getDecimals(ETH_CHAIN_ID, USDC_ID)).to.equal(0);
    });
  });

  // -------------------------------------------------------------------------
  // getDecimals / hasDecimalConfig
  // -------------------------------------------------------------------------
  describe("getDecimals and hasDecimalConfig", () => {
    it("reverts on getDecimals for an unregistered pair", async () => {
      const { normalizer } = await deploy();

      await expect(
        normalizer.getDecimals(ETH_CHAIN_ID, USDC_ID)
      ).to.be.revertedWithCustomError(normalizer, "UnknownDecimalConfig");
    });

    it("returns false from hasDecimalConfig for an unregistered pair", async () => {
      const { normalizer } = await deploy();
      expect(await normalizer.hasDecimalConfig(ETH_CHAIN_ID, USDC_ID)).to.equal(false);
    });

    it("returns true from hasDecimalConfig after registration", async () => {
      const { normalizer, owner } = await deploy();
      await normalizer.connect(owner).registerDecimalConfig(ETH_CHAIN_ID, USDC_ID, 6);
      expect(await normalizer.hasDecimalConfig(ETH_CHAIN_ID, USDC_ID)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // normalize (pure)
  // -------------------------------------------------------------------------
  describe("normalize", () => {
    it("scales up from 6 to 7 decimals correctly (USDC EVM → Stellar)", async () => {
      const { normalizer } = await deploy();
      // 1.000000 USDC (6 dec) = 1_000_000 base units
      // → on Stellar (7 dec) should be 10_000_000 base units
      expect(await normalizer.normalize(1_000_000n, 6, 7)).to.equal(10_000_000n);
    });

    it("scales up from 7 to 18 decimals (Stellar → WETH precision)", async () => {
      const { normalizer } = await deploy();
      // 1.0000000 XLM (7 dec) = 10_000_000 base units
      // → 18-dec representation = 10_000_000 * 10^11 = 1_000_000_000_000_000_000
      const result = await normalizer.normalize(10_000_000n, 7, 18);
      expect(result).to.equal(10_000_000n * 10n ** 11n);
    });

    it("scales down from 7 to 6 when there is no residual (lossless)", async () => {
      const { normalizer } = await deploy();
      // 10_000_000 base units at 7 dec = 10_000_000 / 10 = 1_000_000 at 6 dec
      expect(await normalizer.normalize(10_000_000n, 7, 6)).to.equal(1_000_000n);
    });

    it("reverts with PrecisionLoss when scale-down has a residual", async () => {
      const { normalizer } = await deploy();
      // 1_000_001 at 7 dec → 6 dec: residual = 1
      await expect(
        normalizer.normalize(1_000_001n, 7, 6)
      ).to.be.revertedWithCustomError(normalizer, "PrecisionLoss");
    });

    it("reverts with SameDecimals when src and dst are equal", async () => {
      const { normalizer } = await deploy();
      await expect(
        normalizer.normalize(1_000_000n, 7, 7)
      ).to.be.revertedWithCustomError(normalizer, "SameDecimals");
    });

    it("reverts with ScaleOverflow when scale-up would exceed uint128", async () => {
      const { normalizer } = await deploy();
      // type(uint128).max = 2^128 - 1 ≈ 3.4e38
      // Using a large amount with a large scale factor
      const largeAmount = ethers.MaxUint256 / 2n;
      await expect(
        normalizer.normalize(largeAmount, 0, 38)
      ).to.be.revertedWithCustomError(normalizer, "ScaleOverflow");
    });

    it("reverts with InvalidDecimals when srcDecimals > 38", async () => {
      const { normalizer } = await deploy();
      await expect(
        normalizer.normalize(100n, 39, 6)
      ).to.be.revertedWithCustomError(normalizer, "InvalidDecimals");
    });

    it("reverts with InvalidDecimals when dstDecimals > 38", async () => {
      const { normalizer } = await deploy();
      await expect(
        normalizer.normalize(100n, 6, 39)
      ).to.be.revertedWithCustomError(normalizer, "InvalidDecimals");
    });
  });

  // -------------------------------------------------------------------------
  // normalizeDown (pure)
  // -------------------------------------------------------------------------
  describe("normalizeDown", () => {
    it("truncates precision and returns the residual", async () => {
      const { normalizer } = await deploy();
      // 1_000_003 at 7 dec → 6 dec: floor = 100_000 (wrong, let me recalculate)
      // 1_000_003 / 10 = 100_000 remainder 3
      const [normalized, truncated] = await normalizer.normalizeDown(1_000_003n, 7, 6);
      expect(normalized).to.equal(100_000n);
      expect(truncated).to.equal(3n);
    });

    it("returns zero truncated when division is exact", async () => {
      const { normalizer } = await deploy();
      const [normalized, truncated] = await normalizer.normalizeDown(10_000_000n, 7, 6);
      expect(normalized).to.equal(1_000_000n);
      expect(truncated).to.equal(0n);
    });

    it("returns zero truncated on scale-up", async () => {
      const { normalizer } = await deploy();
      const [normalized, truncated] = await normalizer.normalizeDown(1_000_000n, 6, 7);
      expect(normalized).to.equal(10_000_000n);
      expect(truncated).to.equal(0n);
    });

    it("reverts with SameDecimals when src and dst are equal", async () => {
      const { normalizer } = await deploy();
      await expect(
        normalizer.normalizeDown(1_000_000n, 7, 7)
      ).to.be.revertedWithCustomError(normalizer, "SameDecimals");
    });
  });

  // -------------------------------------------------------------------------
  // isExactlyRepresentable
  // -------------------------------------------------------------------------
  describe("isExactlyRepresentable", () => {
    it("returns true when src <= dst (scale-up is always exact)", async () => {
      const { normalizer } = await deploy();
      expect(await normalizer.isExactlyRepresentable(1_000_001n, 6, 7)).to.equal(true);
    });

    it("returns true when amount is exactly divisible", async () => {
      const { normalizer } = await deploy();
      expect(await normalizer.isExactlyRepresentable(10_000_000n, 7, 6)).to.equal(true);
    });

    it("returns false when amount has sub-destination-unit precision", async () => {
      const { normalizer } = await deploy();
      expect(await normalizer.isExactlyRepresentable(1_000_001n, 7, 6)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // normalizeForRoute (view — uses registered configs)
  // -------------------------------------------------------------------------
  describe("normalizeForRoute", () => {
    async function deployWithConfigs() {
      const { normalizer, owner, other } = await deploy();
      // Stellar USDC: 7 dec
      await normalizer.connect(owner).registerDecimalConfig(STELLAR_CHAIN_ID, USDC_ID, 7);
      // Ethereum USDC: 6 dec
      await normalizer.connect(owner).registerDecimalConfig(ETH_CHAIN_ID, USDC_ID, 6);
      // Polygon USDC: 6 dec
      await normalizer.connect(owner).registerDecimalConfig(POLYGON_CHAIN_ID, USDC_ID, 6);
      // Ethereum WETH: 18 dec
      await normalizer.connect(owner).registerDecimalConfig(ETH_CHAIN_ID, WETH_ID, 18);
      return { normalizer, owner, other };
    }

    it("returns the amount unchanged when src and dst decimals match", async () => {
      const { normalizer } = await deployWithConfigs();
      // Polygon USDC → Ethereum USDC: both 6 dec
      const result = await normalizer.normalizeForRoute(
        1_000_000n, ETH_CHAIN_ID, USDC_ID, POLYGON_CHAIN_ID, USDC_ID
      );
      expect(result).to.equal(1_000_000n);
    });

    it("scales up from Ethereum (6) to Stellar (7)", async () => {
      const { normalizer } = await deployWithConfigs();
      const result = await normalizer.normalizeForRoute(
        1_000_000n, ETH_CHAIN_ID, USDC_ID, STELLAR_CHAIN_ID, USDC_ID
      );
      expect(result).to.equal(10_000_000n);
    });

    it("scales down from Stellar (7) to Ethereum (6) when lossless", async () => {
      const { normalizer } = await deployWithConfigs();
      const result = await normalizer.normalizeForRoute(
        10_000_000n, STELLAR_CHAIN_ID, USDC_ID, ETH_CHAIN_ID, USDC_ID
      );
      expect(result).to.equal(1_000_000n);
    });

    it("reverts with UnknownDecimalConfig for unregistered source chain", async () => {
      const { normalizer } = await deployWithConfigs();
      await expect(
        normalizer.normalizeForRoute(1_000_000n, 999, USDC_ID, ETH_CHAIN_ID, USDC_ID)
      ).to.be.revertedWithCustomError(normalizer, "UnknownDecimalConfig");
    });

    it("reverts with UnknownDecimalConfig for unregistered destination chain", async () => {
      const { normalizer } = await deployWithConfigs();
      await expect(
        normalizer.normalizeForRoute(1_000_000n, ETH_CHAIN_ID, USDC_ID, 999, USDC_ID)
      ).to.be.revertedWithCustomError(normalizer, "UnknownDecimalConfig");
    });
  });

  // -------------------------------------------------------------------------
  // transferOwnership
  // -------------------------------------------------------------------------
  describe("transferOwnership", () => {
    it("transfers ownership and emits OwnershipTransferred", async () => {
      const { normalizer, owner, other } = await deploy();

      await expect(normalizer.connect(owner).transferOwnership(other.address))
        .to.emit(normalizer, "OwnershipTransferred")
        .withArgs(owner.address, other.address);

      expect(await normalizer.owner()).to.equal(other.address);
    });

    it("reverts when a non-owner attempts transferOwnership", async () => {
      const { normalizer, other } = await deploy();
      await expect(
        normalizer.connect(other).transferOwnership(other.address)
      ).to.be.revertedWithCustomError(normalizer, "Unauthorized");
    });

    it("reverts when transferring to the zero address", async () => {
      const { normalizer, owner } = await deploy();
      await expect(
        normalizer.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWith("TokenDecimalNormalizer: zero owner");
    });
  });
});
