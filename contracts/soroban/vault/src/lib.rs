#![no_std]
pub mod escrow_accounting;
pub mod queries;

use soroban_sdk::{contract, contractimpl, Address, Env};
use queries::{get_vault_balance, VaultBalanceQueryResult};
use escrow_accounting::{record_deposit, record_release, tracked_balance};

#[contract]
pub struct SorobanVaultContract;

#[contractimpl]
impl SorobanVaultContract {
    /// Query the vault balance, returning both the tracked ledger value and the
    /// supplied on-chain actual balance for invariant comparison.
    pub fn get_balance(env: Env, token: Address, tracked: i128, actual: i128) -> VaultBalanceQueryResult {
        get_vault_balance(&env, token, tracked, actual)
    }

    /// Record that `amount` tokens have been deposited into the escrow ledger.
    pub fn deposit(env: Env, token: Address, amount: i128) {
        record_deposit(&env, &token, amount);
    }

    /// Record that `amount` tokens have been released from the escrow ledger.
    pub fn release(env: Env, token: Address, amount: i128) {
        record_release(&env, &token, amount);
    }

    /// Return the current tracked escrow balance for `token`.
    pub fn escrow_balance(env: Env, token: Address) -> i128 {
        tracked_balance(&env, &token)
    }
}
