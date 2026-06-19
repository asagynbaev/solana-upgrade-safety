# Security Policy

`solana-upgrade-safety` is an **advisory** pre-upgrade gate. It narrows risk by
diffing account layouts; it does not guarantee an upgrade is safe (see the
[Limitations](README.md#limitations-read-these--they-matter) in the README). The
fork-replay step is what confirms what static analysis cannot.

## What to report

The most valuable reports are **misclassifications** — cases where the differ's
verdict is wrong, because a wrong verdict on a live program can lead to bricked or
drained accounts:

- A genuinely **BREAKING** or **NEEDS_MIGRATION** change reported as **SAFE**
  (a false green — the most dangerous case).
- A byte-compatible change reported as **BREAKING** (a false block).
- A crash, hang, or wrong exit code on a valid Anchor / Codama IDL.
- Anything in the skill docs that is technically incorrect about Borsh, zero-copy,
  `realloc`, discriminators, or migration.

A minimal reproducer is ideal: the two IDL JSONs (or a trimmed pair) and the
verdict you expected vs. what you got.

## How to report

- For a **non-sensitive bug or misclassification**, open a normal GitHub issue
  with the reproducer.
- For anything you consider **sensitive**, use GitHub's private
  **"Report a vulnerability"** flow (Security tab → Report a vulnerability) on this
  repository, or email the maintainer at the address on their GitHub profile.

Please do not include real private keys, mainnet authority secrets, or other
secrets in a report — a stripped-down IDL is enough to reproduce a layout issue.
