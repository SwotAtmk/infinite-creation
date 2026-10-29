#!/usr/bin/env bash
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
pnpm run dev:classic
