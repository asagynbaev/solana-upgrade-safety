# Upgrade Authority & Safe Deploy

The layout is safe and the build is verified — now ship it without fumbling the
deploy itself. This covers the upgradeable-loader model, buffer deploys, multisig
authority, the immutability decision, and rollback.

## The upgradeable loader model

A program deployed with the upgradeable BPF loader is two accounts:
- the **program account** (the address everyone calls), which points to
- the **program-data account**, which holds the bytecode **and the upgrade
  authority**.

Whoever holds the upgrade authority can replace the bytecode. That key is the
single most powerful thing in your protocol — protect it accordingly.

```bash
solana program show <PROGRAM_ID>   # shows authority, data len, last deployed slot
```

## Buffer deploy (don't deploy straight over a live program)

Deploying directly into the program account is risky: a failed deploy can leave it
in a bad state, and on mainnet you usually want the new bytecode staged and
reviewed before activation. Use an intermediate **buffer**:

```bash
# 1. Write the verified .so to a buffer account
solana program write-buffer target/deploy/vault.so
# → prints a BUFFER_ADDRESS

# 2. (recommended) set the buffer authority to your multisig so it can approve
solana program set-buffer-authority <BUFFER_ADDRESS> --new-buffer-authority <MULTISIG>

# 3. Upgrade the program from the buffer (this is the activation step)
solana program upgrade <BUFFER_ADDRESS> <PROGRAM_ID> --upgrade-authority <AUTH>
```

Staging via buffer also lets the multisig review the exact bytecode hash
(`solana-verify get-executable-hash`) before the upgrade transaction is signed.

## Multisig upgrade authority (Squads)

On mainnet, the upgrade authority should **not** be a single hot key. Use a
multisig — Squads is the standard on Solana — so an upgrade requires N-of-M
approvals.

Flow:
1. Transfer upgrade authority to the Squads multisig (once):
   ```bash
   solana program set-upgrade-authority <PROGRAM_ID> \
     --new-upgrade-authority <SQUADS_VAULT_PDA>
   ```
2. For each upgrade, propose the `bpf_loader_upgradeable::upgrade` transaction (or
   the buffer upgrade) inside Squads.
3. Signers review: the buffer hash, the `layout-diff` report, the fork-sim result.
4. Once threshold is met, execute. The activation is atomic.

This means the safety artifacts from this skill (layout diff, verified hash, fork
replay) become the **review packet** the signers approve against. Attach them to
the proposal.

## Immutability decision

You can remove the upgrade authority entirely, making the program permanently
immutable:

```bash
solana program set-upgrade-authority <PROGRAM_ID> --final
```

- **Pro**: maximum trust — nobody, including you, can ever change the code.
- **Con**: you can never patch a bug or migrate again. A latent vulnerability is
  forever.
- **Guidance**: most live protocols keep upgradeability behind a multisig +
  timelock rather than going fully immutable, precisely so they can respond to
  incidents and run migrations. Go immutable only when the program is small,
  battle-tested, audited, and intentionally frozen.

## Pre-upgrade checklist (the go/no-go gate)

- [ ] `npx tsx layout-diff.ts --strict` clean, or the only delta is the field you migrate.
- [ ] If migrating: migration written, idempotent, per-account atomic.
- [ ] Replayed on a mainnet fork against **real** accounts — reads, migration, and
      normal instructions all pass; invariants hold.
- [ ] Built with `solana-verify`; executable hash recorded.
- [ ] Buffer written from the verified `.so`; buffer hash == approved hash.
- [ ] Upgrade authority is the multisig; proposal includes the review packet.
- [ ] Rollback plan exists (see below).
- [ ] Deploy timed for low activity; priority fees set so the upgrade tx lands.

## Rollback

There is no automatic rollback on Solana — an upgrade is just another upgrade. Plan
for it:
- Keep the **previous verified `.so`** and its hash. Rolling back = deploying the
  old binary via the same buffer flow.
- If the new version changed account layout, **rolling back the code does not roll
  back migrated accounts.** A reverse migration (or forward-only fixes) may be
  required. This is a strong reason to make layout changes additive and reversible.
- For emergencies, having an admin-gated `pause` instruction (set a flag that halts
  state-changing handlers) buys time to prepare a fix without an immediate upgrade.

## One-paragraph summary

Stage the verified binary in a buffer, let a Squads multisig approve it against a
review packet (layout diff + verified hash + fork-sim result), upgrade from the
buffer, then confirm the on-chain hash matches. Keep upgradeability behind the
multisig unless you have a deliberate reason to burn the authority — you'll want it
the day you need to migrate or patch.
