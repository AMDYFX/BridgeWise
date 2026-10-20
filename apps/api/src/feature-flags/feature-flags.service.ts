import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/config-factory';
import { EnvironmentConfigService } from '../config/environment-config.service';

export type FeatureFlags = AppConfig['features'];
export type FeatureFlagName = keyof FeatureFlags;

export interface PartnerFeatureFlags {
  partnerId: string;
  flags: Partial<FeatureFlags>;
}

/**
 * Feature Flags Service
 *
 * Central service for reading feature-flag state at runtime.
 * Flags are sourced from environment variables and are therefore
 * configurable per deployment without a code change or redeploy
 * (a process restart is required to pick up env-var changes).
 *
 * Supports partner-specific feature flag overrides.
 */
@Injectable()
export class FeatureFlagsService {
  private partnerOverrides: Map<string, Partial<FeatureFlags>> = new Map();

  constructor(
    private readonly environmentConfigService: EnvironmentConfigService,
  ) {}

  /**
   * Returns all feature flags and their current enabled/disabled state.
   */
  getAll(): FeatureFlags {
    return this.environmentConfigService.getFeatures();
  }

  /**
   * Returns true when the given flag is enabled, false otherwise.
   */
  isEnabled(flag: FeatureFlagName): boolean {
    return this.environmentConfigService.isFeatureEnabled(flag);
  }

  /**
   * Returns true when the given flag is disabled.
   */
  isDisabled(flag: FeatureFlagName): boolean {
    return !this.isEnabled(flag);
  }

  /**
   * Sets partner-specific feature flag overrides.
   * Partner flags take precedence over global flags.
   */
  setPartnerFlags(partnerId: string, flags: Partial<FeatureFlags>): void {
    this.partnerOverrides.set(partnerId, flags);
  }

  /**
   * Gets partner-specific feature flag overrides.
   */
  getPartnerFlags(partnerId: string): Partial<FeatureFlags> | undefined {
    return this.partnerOverrides.get(partnerId);
  }

  /**
   * Checks if a feature flag is enabled for a specific partner.
   * Partner-specific flags override global flags.
   */
  isEnabledForPartner(flag: FeatureFlagName, partnerId: string): boolean {
    const partnerFlags = this.partnerOverrides.get(partnerId);
    if (partnerFlags && flag in partnerFlags) {
      return partnerFlags[flag] === true;
    }
    return this.isEnabled(flag);
  }

  /**
   * Removes partner-specific feature flag overrides.
   */
  clearPartnerFlags(partnerId: string): void {
    this.partnerOverrides.delete(partnerId);
  }

  /**
   * Clears all partner-specific overrides.
   */
  clearAllPartnerFlags(): void {
    this.partnerOverrides.clear();
  }
}
