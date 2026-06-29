# Fork Simulation

A passing `layout-diff` proves the *schema* is compatible. It does not prove your
upgraded program + migration actually work against the messy reality of accounts
on mainnet. Replay against real state before you touch mainnet.

This uses **Surfpool**, a mainnet-fork local validator (think Anvil for Solana).
It is already wired into the kit as an MCP (`surfpool mcp`) and as a CLI.

## Why a fork and not just LiteSVM/devnet

- **Devnet is not mainnet state.** Your real accounts, with their real historical
  data, only exist on mainnet.
- **A fork loads real mainnet accounts on demand** and lets you run *your candidate
  build* against them, locally, for free, without risk.
- This is the only way to catch: old accounts that don't deserialize, a migration
  that corrupts a real edge-case account, CPIs into protocols whose on-chain state
  you don't control, and rent/space math that's wrong for real sizes.

## Workflow

### 1. Start a fork pinned to a recent slot

```bash
surfpool start --rpc-url https://api.mainnet-beta.solana.com
# (mainnet-beta is the default upstream, so bare `surfpool start` works too.)
# For reproducibility, capture the slot the run forked from (and pin the upstream RPC);
# check `surfpool start --help` for the slot/freeze options in your version.
```

Surfpool lazily fetches any account you touch from the upstream RPC, so you don't
need to pre-load anything.

### 2. Deploy the CANDIDATE build over the existing program

Upgrade the program in place on the fork so you exercise the new bytecode against
old state. A direct deploy is fine here — the fork is a sandbox, so you don't need
the buffer + multisig staging you'd use on mainnet (that flow lives in
`upgrade-authority.md`):

```bash
solana program deploy target/deploy/vault.so \
  --program-id <PROGRAM_ID> --url http://127.0.0.1:8899 \
  --upgrade-authority <AUTHORITY_KEYPAIR>
```

The real `Vault` accounts are still the OLD layout — which is the whole point.

### 3. Assert old accounts deserialize (or fail as expected)

Pick several **real** account addresses (a few typical, a few weird — biggest,
oldest, smallest, ones with optional/vec fields populated). For each:

- Try to read it with the new program's account fetch.
- A `BREAKING` change shows up here as deserialization failure or nonsense values.
- A `NEEDS_MIGRATION` change shows up as `AccountDidNotDeserialize` until migrated.

```ts
// against the fork RPC at http://127.0.0.1:8899
for (const addr of REAL_VAULT_ADDRESSES) {
  try {
    const v = await program.account.vault.fetch(addr);
    assert(v.owner && v.totalDeposited !== undefined, `garbage at ${addr}`);
  } catch (e) {
    // expected ONLY if you're mid-migration; otherwise this is a red flag
    console.error(`deserialize failed at ${addr}:`, e.message);
  }
}
```

### 4. Run the migration against real accounts, then re-assert

```ts
await program.methods.migrateVault().accounts({ vault: addr, authority }).rpc();
const v = await program.account.vault.fetch(addr);
assert.equal(v.owner.toBase58(), KNOWN_OWNER);          // preserved
assert.equal(v.totalDeposited.toString(), KNOWN_TOTAL); // preserved
assert.equal(v.paused, false);                          // new field defaulted
```

Then run the **normal** instructions (deposit/withdraw/etc.) on the migrated
account and assert program invariants still hold. Re-run migrate to confirm it's a
no-op (idempotent).

### 5. Exercise the worst real accounts

Don't just test a fresh account you made. Enumerate real ones and migrate a sample
across the size distribution. Bugs live in the account that has the optional field
set, the vec at max length, the one created two program versions ago.

## Checklist before promoting to mainnet

- [ ] `npx tsx layout-diff.ts --strict` returns 0 (or only the field you're deliberately migrating).
- [ ] On fork: a sample of real old accounts read correctly post-upgrade (or post-migration).
- [ ] On fork: migration preserves owner/balances/critical fields on real accounts.
- [ ] On fork: normal instructions work on migrated accounts; invariants hold.
- [ ] Migration is idempotent and per-account atomic.
- [ ] CPIs your program makes still succeed against real upstream state.
- [ ] You captured the fork slot so the run is reproducible.

If any box fails, you found a bricking upgrade in a sandbox instead of on mainnet —
which is exactly the point of this skill.
