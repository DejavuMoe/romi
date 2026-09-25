# v14 视觉收敛

状态：已批准并实施（设计提交 5e41a19）。v14 取代 v12 成为现行规格；它只改呈现，不增删功能和文案。

入口：

- `index.html`：管理后台，重点为节点管理与节点详情；
- `public.html`：公开状态页，卡片、列表与节点详情；
- `system.html`：设计规范，同一组件分别以亮色与暗色渲染。

三者共用 `styles.css`，它按「设计变量 → 基础 → 控件 → 表单 → 反馈 → 弹窗 → 外壳 → 面板 → 用量 → 表格 → 卡片 → 详情 → 响应式」排列。
变量名与 `styles/theme.css` 一致；在媒体查询之外，每个选择器的每个属性只赋值一次。
通用表单规则写在 `:where()` 中，组件规则无需提高优先级即可覆盖。`system.css` 只负责规范页排版。

界面字体默认等宽；加 `?font=sans` 预览无衬线界面字体，数据在两种情况下都保持等宽。
`?theme=dark`、`?state=<状态>` 与 v12 相同。

检查：

- `node designs/romi-next/revision-v14/verify.cjs`：JSX 语法；
- `node designs/romi-next/revision-v14/exercise-v14.cjs <base>`：在浏览器中实测圆角与阴影、五种宽度的溢出、
  公开页不显示地址、390px 触控尺寸、管理列表首行对齐、字体与焦点，并采集 `captures/v14-*.json`；
- `node designs/romi-next/revision-v14/shots.cjs <base> <dir>`：审阅截图。

两个脚本都连接已运行的预览服务：`node designs/preview.mjs 4311`。
