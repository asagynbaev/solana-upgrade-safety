# Verified Builds

Before a multisig signs off on an upgrade, the signers need to confirm that the
bytecode about to go on-chain is built from the source they reviewed — and after
deploy, users need to confirm the on-chain program matches the published source. A
verifiable (reproducible) build gives you both.

Tool: **`solana-verify`** (deterministic Docker build + on-chain hash comparison).

## Why this belongs in an upgrade gate

- An upgrade replaces bytecode. "Trust me, this `.so` is the audited code" is not
  good enough for a mainnet program holding funds.
- A reproducible build lets *anyone* rebuild from a git commit and get the **same**
  hash that's deployed. That's the difference between "audited source" and "audited
  program".
- It closes the gap where a clean repo is audited but a tampered or differently-
  built binary gets deployed.

## Install

```bash
cargo install solana-verify
# requires Docker running (the build happens in a pinned container for determinism)
```

## Build reproducibly

```bash
solana-verify build
# produces target/deploy/<program>.so in a deterministic container
```

Get the hash of what you built, and of what's currently on-chain:

```bash
solana-verify get-executable-hash target/deploy/vault.so
solana-verify get-program-hash <PROGRAM_ID> --url <rpc>
```

If you're verifying the *current* deployment matches a repo:

```bash
solana-verify verify-from-repo \
  --program-id <PROGRAM_ID> \
  https://github.com/<org>/<repo> \
  --commit-hash <COMMIT> \
  --url <rpc>
```

This builds the given commit in the container, hashes it, fetches the on-chain
program hash, and tells you if they match.

To publish the verification to the public OtterSec registry (`verify.osec.io`) so
wallets/explorers display "verified" for your program, submit a remote job (the old
`--remote` flag on `verify-from-repo` is deprecated):

```bash
solana-verify remote submit-job --program-id <PROGRAM_ID> --uploader <YOUR_ADDRESS>
```

## How to use it in the upgrade flow

1. `solana-verify build` the candidate from a clean, tagged commit.
2. Record the executable hash. This is the artifact the multisig approves.
3. Write the buffer from **that exact `.so`** (see `upgrade-authority.md`).
4. After the upgrade lands, `get-program-hash <PROGRAM_ID>` and confirm it equals
   the approved hash. Publish the commit + hash so users can independently verify.

## Gotchas

- Determinism is sensitive to toolchain versions; let `solana-verify` control the
  container rather than building on your host.
- The hash covers the program binary, not the IDL. Keep the IDL in sync separately
  (`anchor idl upgrade`) and version it in the repo.
- Verifying a *closed-source* program isn't possible; this is for programs whose
  source you publish (or share privately with auditors/signers who rebuild).
