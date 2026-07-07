# Question bank

Generated question banks live here as `unit-NN.json`, one per unit, produced by
`scripts/build_question_bank.ts` and served by `src/server/questionBank.ts`.

Build (use the top model — generation is one-time and quality is paramount):

```bash
# Full build (all 17 units, default targets: 30 MC/TF/FITB, 10 FR per level)
GEN_MODEL=claude-opus-4-8 npm run bank:build

# Cheap test (one unit, small counts)
GEN_MODEL=claude-opus-4-8 npm run bank:build -- --units=17 --mc=3 --tf=2 --fitb=2 --fr=1
```

The generated `unit-NN.json` files are committed (like `content/units/`). See
`docs/question-bank-plan.md` for the full plan and phases.
