# 许可与标志

romi 由 Dejavu Moe 以 MIT 协议授权，许可证全文见仓库根目录的 [LICENSE](https://github.com/DejavuMoe/romi/blob/master/LICENSE)。

发布的二进制与 Agent 镜像所含第三方组件的版本、许可与原文见 [THIRD_PARTY_LICENSES.txt](https://github.com/DejavuMoe/romi/blob/master/THIRD_PARTY_LICENSES.txt)，
它由锁文件生成、在 CI 中核对，并随每个发布归档及 Agent 镜像（`/licenses/`）分发。
概览与仓库内其他素材（如状态页地球与昼夜图使用的 world-atlas 陆地数据）的来源见 [THIRD_PARTY_NOTICES.md](https://github.com/DejavuMoe/romi/blob/master/THIRD_PARTY_NOTICES.md)。

界面只使用系统字体，不分发字体文件。

## romi 标志

romi 使用小写名称。标志以小写 `r` 为骨架，肩部弧线延伸为轨道，前方圆点代表探针；主色为紫色 `#5a44ee`。

文档站使用与公开页浏览器图标相同的静态 SVG，文件为 `docs/public/logo.svg`。产品中的标志定义在 `web/src/components/ui/brand.tsx`：探针颜色随节点整体状态变化，文档站的静态标志不表示运行状态。
