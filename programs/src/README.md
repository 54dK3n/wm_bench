# Robot program source

These modules are the sole source of `programs/world_model_opt2.py`.
They are concatenated in `tools/build_opt2_program.py:SOURCE_ORDER`, so they
share the single student-function scope used by the native platform worker.
Do not import them as independent runtime modules or add duplicate top-level
function definitions.

Build from the project root:

```bash
python3 tools/build_opt2_program.py
```

The builder verifies `vendor/worldmodel.lock.json`, embeds the locked
`world_model/*.py` files with fixed ZIP metadata, and injects program/package
identity plus the passing measured turn calibration. The `.build.json`
manifest contains project-relative paths and SHA256 values. No old generated
program, local Git checkout, simulation or text replacement is involved.

The modules preserve opt2 round-3 live function bodies and initialization
order. `wm_bootstrap.py` explicitly selects
`guangyang_static_world_model(max_range_m=0.9)` to preserve that program's
former Guangyang configuration after generic WorldModel defaults were restored.

Historical source fixtures live in `artifacts/inloop/refactor/legacy_sources/`
and are not build inputs. Exact removed definitions and source moves are in
`artifacts/inloop/refactor/deletions.json`; behavior issues intentionally left
for the later phase are in `artifacts/inloop/refactor/bugs.json`.
