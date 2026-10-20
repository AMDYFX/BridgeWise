import { expect } from "chai";
import hre from "hardhat";

/**
 * Contract-level tests for ChainClockSkewGuard.
 *
 * Because Hardhat's `block.timestamp` is deterministic we can set it
 * precisely and verify each boundary case. The tests cover:
 *
 *   - Deployment and owner configuration
 *   - Per-chain tolerance registration (auth + happy path)
 *   - Global default tolerance update
 *   - assertFresh: accepts messages within tolerance
 *   - assertFresh: rejects at exact boundary + 1 second
 *   - assertFresh: rejects zero timestamp
 *   - assertFresh: rejects messages from the future beyond futureDrift
 *   - assertFresh: accepts future messages within futureDrift
 *   - isFresh view: mirrors assertFresh without reverting
 *   - getEffectiveTolerance: per-chain override vs default fallback
 *   - Ownership transfer
 *   - Simulated dependency failure: unregistered chain falls back to default
 */
describe("ChainClockSkewGuard", () => {
  let ethers: any;
  let networkHelpers: any;

  before(async () => {
    const connection = await hre.network.create();
    ethers = connection.ethers;
    networkHelpers = connection.networkHelpers;
  });

  // Default tolerance: 60 s, future drift: 30 s
  const DEFAULT_TOLERANCE  = 60;   // seconds
  const DEFAULT_DRIFT      = 30;   // seconds

  // Chain IDs used as keys
  const STELLAR_CHAIN_ID  = 100;
  const ETH_CHAIN_ID      = 1;

  // -------------------------------------------------------------------------
  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ChainClockSkewGuard");
    const guard = await Factory.deploy(
      owner.address,
      DEFAULT_TOLERANCE,
      DEFAULT_DRIFT
    );
    await guard.waitForDeployment();
    return { guard, owner, other };
  }

  // -------------------------------------------------------------------------
  // Deployment
  // -------------------------------------------------------------------------
  describe("deployment", () => {
    it("sets owner, defaultToleranceSecs, defaultFutureDriftSecs", async () => {
      const { guard, owner } = await deploy();
      expect(await guard.owner()).to.equal(owner.address);
      expect(await guard.defaultToleranceSecs()).to.equal(DEFAULT_TOLERANCE);
      expect(await guard.defaultFutureDriftSecs()).to.equal(DEFAULT_DRIFT);
    });

    it("reverts with zero owner", async () => {
      const Factory = await ethers.getContractFactory("ChainClockSkewGuard");
      await expect(
        Factory.deploy(ethers.ZeroAddress, DEFAULT_TOLERANCE, DEFAULT_DRIFT)
      ).to.be.revertedWith("ChainClockSkewGuard: zero owner");
    });

    it("reverts with zero tolerance", async () => {
      const [owner] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("ChainClockSkewGuard");
      await expect(
        Factory.deploy(owner.address, 0, DEFAULT_DRIFT)
      ).to.be.revertedWith("ChainClockSkewGuard: zero tolerance");
    });
  });

  // -------------------------------------------------------------------------
  // setTolerance
  // -------------------------------------------------------------------------
  describe("setTolerance", () => {
    it("registers a per-chain tolerance and emits ToleranceSet", async () => {
      const { guard, owner } = await deploy();
      await expect(
        guard.connect(owner).setTolerance(STELLAR_CHAIN_ID, 30, 15)
      )
        .to.emit(guard, "ToleranceSet")
        .withArgs(STELLAR_CHAIN_ID, 30, 15);

      const [tol, drift] = await guard.getEffectiveTolerance(STELLAR_CHAIN_ID);
      expect(tol).to.equal(30);
      expect(drift).to.equal(15);
    });

    it("reverts when called by non-owner", async () => {
      const { guard, other } = await deploy();
      await expect(
        guard.connect(other).setTolerance(STELLAR_CHAIN_ID, 30, 15)
      ).to.be.revertedWithCustomError(guard, "Unauthorized");
    });

    it("reverts with zero tolerance", async () => {
      const { guard, owner } = await deploy();
      await expect(
        guard.connect(owner).setTolerance(STELLAR_CHAIN_ID, 0, 15)
      ).to.be.revertedWith("ChainClockSkewGuard: zero tolerance");
    });
  });

  // -------------------------------------------------------------------------
  // setDefaultTolerance
  // -------------------------------------------------------------------------
  describe("setDefaultTolerance", () => {
    it("updates the default and emits DefaultToleranceSet", async () => {
      const { guard, owner } = await deploy();
      await expect(guard.connect(owner).setDefaultTolerance(120, 60))
        .to.emit(guard, "DefaultToleranceSet")
        .withArgs(120, 60);

      expect(await guard.defaultToleranceSecs()).to.equal(120);
      expect(await guard.defaultFutureDriftSecs()).to.equal(60);
    });

    it("reverts when called by non-owner", async () => {
      const { guard, other } = await deploy();
      await expect(
        guard.connect(other).setDefaultTolerance(120, 60)
      ).to.be.revertedWithCustomError(guard, "Unauthorized");
    });
  });

  // -------------------------------------------------------------------------
  // getEffectiveTolerance — fallback to default
  // -------------------------------------------------------------------------
  describe("getEffectiveTolerance", () => {
    it("returns per-chain values when registered", async () => {
      const { guard, owner } = await deploy();
      await guard.connect(owner).setTolerance(STELLAR_CHAIN_ID, 30, 15);
      const [tol, drift] = await guard.getEffectiveTolerance(STELLAR_CHAIN_ID);
      expect(tol).to.equal(30);
      expect(drift).to.equal(15);
    });

    it("falls back to defaults for unregistered chains", async () => {
      const { guard } = await deploy();
      const [tol, drift] = await guard.getEffectiveTolerance(999);
      expect(tol).to.equal(DEFAULT_TOLERANCE);
      expect(drift).to.equal(DEFAULT_DRIFT);
    });
  });

  // -------------------------------------------------------------------------
  // assertFresh — happy path
  // -------------------------------------------------------------------------
  describe("assertFresh — accepts valid messages", () => {
    it("accepts a message timestamped at block.timestamp (zero age)", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      // Should not revert
      await guard.assertFresh(now, ETH_CHAIN_ID);
    });

    it("accepts a message at the exact tolerance boundary (age == toleranceSecs)", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      const msgTs = now - DEFAULT_TOLERANCE; // exactly at boundary
      await guard.assertFresh(msgTs, ETH_CHAIN_ID); // should not revert
    });

    it("accepts a message with a small future timestamp within futureDrift", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      const msgTs = now + DEFAULT_DRIFT; // exactly at drift boundary
      await guard.assertFresh(msgTs, ETH_CHAIN_ID);
    });
  });

  // -------------------------------------------------------------------------
  // assertFresh — rejection cases
  // -------------------------------------------------------------------------
  describe("assertFresh — rejects invalid messages", () => {
    it("reverts with MessageTooOld when age exceeds tolerance by 1 second", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      const msgTs = now - DEFAULT_TOLERANCE - 1;
      await expect(
        guard.assertFresh(msgTs, ETH_CHAIN_ID)
      ).to.be.revertedWithCustomError(guard, "MessageTooOld");
    });

    it("MessageTooOld carries the correct ageSecs and toleranceSecs", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      const msgTs = now - 120; // 120 s old > 60 s tolerance
      await expect(guard.assertFresh(msgTs, ETH_CHAIN_ID))
        .to.be.revertedWithCustomError(guard, "MessageTooOld")
        .withArgs(msgTs, now + 1, 120 + 1, DEFAULT_TOLERANCE);
        // +1 because the tx mines one block (timestamp advances by 1)
    });

    it("reverts with MessageFromFuture when future drift is exceeded", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      const msgTs = now + DEFAULT_DRIFT + 1;
      await expect(
        guard.assertFresh(msgTs, ETH_CHAIN_ID)
      ).to.be.revertedWithCustomError(guard, "MessageFromFuture");
    });

    it("reverts with ZeroTimestamp for a zero message timestamp", async () => {
      const { guard } = await deploy();
      await expect(
        guard.assertFresh(0, ETH_CHAIN_ID)
      ).to.be.revertedWithCustomError(guard, "ZeroTimestamp");
    });

    it("rejects a very old message regardless of chain", async () => {
      const { guard } = await deploy();
      await expect(
        guard.assertFresh(1, ETH_CHAIN_ID) // Unix epoch start
      ).to.be.revertedWithCustomError(guard, "MessageTooOld");
    });
  });

  // -------------------------------------------------------------------------
  // assertFresh — per-chain tolerance respected
  // -------------------------------------------------------------------------
  describe("assertFresh — per-chain tolerance", () => {
    it("accepts a 40-second-old message when per-chain tolerance is 60 s", async () => {
      const { guard, owner } = await deploy();
      await guard.connect(owner).setTolerance(STELLAR_CHAIN_ID, 60, 30);
      const now = await networkHelpers.time.latest();
      await guard.assertFresh(now - 40, STELLAR_CHAIN_ID);
    });

    it("rejects a 40-second-old message when per-chain tolerance is 30 s", async () => {
      const { guard, owner } = await deploy();
      await guard.connect(owner).setTolerance(STELLAR_CHAIN_ID, 30, 15);
      const now = await networkHelpers.time.latest();
      await expect(
        guard.assertFresh(now - 40, STELLAR_CHAIN_ID)
      ).to.be.revertedWithCustomError(guard, "MessageTooOld");
    });
  });

  // -------------------------------------------------------------------------
  // isFresh view function
  // -------------------------------------------------------------------------
  describe("isFresh", () => {
    it("returns true for a fresh message", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      expect(await guard.isFresh(now, ETH_CHAIN_ID)).to.equal(true);
    });

    it("returns false for a stale message", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      expect(await guard.isFresh(now - 300, ETH_CHAIN_ID)).to.equal(false);
    });

    it("returns false for a zero timestamp", async () => {
      const { guard } = await deploy();
      expect(await guard.isFresh(0, ETH_CHAIN_ID)).to.equal(false);
    });

    it("returns false for a future timestamp beyond drift", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      expect(await guard.isFresh(now + DEFAULT_DRIFT + 100, ETH_CHAIN_ID)).to.equal(false);
    });

    it("returns true for a future timestamp within drift", async () => {
      const { guard } = await deploy();
      const now = await networkHelpers.time.latest();
      // Slightly inside the drift (5 s); isFresh is a view so no block advance
      expect(await guard.isFresh(now + 5, ETH_CHAIN_ID)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // transferOwnership
  // -------------------------------------------------------------------------
  describe("transferOwnership", () => {
    it("transfers ownership and emits OwnershipTransferred", async () => {
      const { guard, owner, other } = await deploy();
      await expect(guard.connect(owner).transferOwnership(other.address))
        .to.emit(guard, "OwnershipTransferred")
        .withArgs(owner.address, other.address);
      expect(await guard.owner()).to.equal(other.address);
    });

    it("reverts for non-owner caller", async () => {
      const { guard, other } = await deploy();
      await expect(
        guard.connect(other).transferOwnership(other.address)
      ).to.be.revertedWithCustomError(guard, "Unauthorized");
    });

    it("reverts for zero address", async () => {
      const { guard, owner } = await deploy();
      await expect(
        guard.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWith("ChainClockSkewGuard: zero owner");
    });
  });
});
