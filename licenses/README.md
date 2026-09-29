# 第三方许可原文

`scripts/third_party.py` 生成 `THIRD_PARTY_LICENSES.txt` 时，大多数许可原文直接取自 cargo registry 与 `node_modules` 中的包。
本目录只存放包本身没有附带、需要从上游取得的原文：

| 路径 | 来源 |
| --- | --- |
| `duckdb-v1.5.5/<组件>.txt` | [duckdb/duckdb](https://github.com/duckdb/duckdb/tree/v1.5.5/third_party) `v1.5.5` 标签下 `third_party/<组件>/` 的许可文件；`libduckdb-sys` 编入这些 C/C++ 组件，但发布的 crate 不含其许可 |
| `shadcn-ui.txt` | [shadcn-ui/ui](https://github.com/shadcn-ui/ui) 的 `LICENSE.md`；`admin/src/components/ui/` 中的组件由其生成 |
| `world-atlas.txt` | [topojson/world-atlas](https://github.com/topojson/world-atlas) `v2.0.2` 的 `LICENSE`（ISC）；`shared/land.ts` 的陆地格点由其 `land-110m.json` 栅格化而来，底层数据为 Natural Earth 1:110m 陆地（公有领域） |
| `packages/<包名>.txt` | 发布包未附许可文件时，取自该包上游仓库的许可文件（`duckdb`、`react-remove-scroll-bar`、`victory-vendor`） |

升级 DuckDB 时按新版本另建 `duckdb-vX.Y.Z/`（版本取自 `server/src/db/schema.rs` 的 `ENGINE_VERSION`）；
依赖变化后运行 `python3 scripts/third_party.py generate`。`make check-licenses` 在两者不一致时失败。
