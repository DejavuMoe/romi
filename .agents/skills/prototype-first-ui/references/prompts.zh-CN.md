# 使用示例

## 共享设计系统

```text
$prototype-first-ui system
基于现有品牌与组件建立项目设计系统，包含语义令牌、组件状态、预览和使用方法。
只保存在当前项目，不安装或配置全局技能。
```

## 视觉传播

```text
$prototype-first-ui compose
使用项目设计系统与提供的文案，制作六页产品介绍和一页讲义。
保留可编辑源文件，检查两种格式的渲染结果，并明确缺失的导出能力。
```

## 数据可视化

```text
$prototype-first-ui visualize
基于这份 CSV 和项目设计系统制作看板，定义指标与日期语义，
核对汇总和筛选结果，并保留来源追溯。
```

## 产品审计

```text
$prototype-first-ui audit
审计当前产品的页面、操作、状态和接口，记录到 docs/ui/capabilities.md。
```

## 方向探索

```text
$prototype-first-ui explore
基于现有能力和设计系统，为 <产品> 探索三个导航与工作区布局方向。
```

## 制作原型

```text
$prototype-first-ui prototype
在 designs/<project>/ 中制作 <功能> 原型，覆盖正常流程、空状态、错误和取消操作，完成后展示供审阅。
```

## 批准原型

```text
$prototype-first-ui approve
我批准当前 designs/<project>/index.html，登记批准状态并创建纯设计提交。
```

## 生产实现

```text
$prototype-first-ui implement
实现设计提交 <SHA> 中已批准的 designs/<project>/index.html，本次范围为 <功能>。
```

## 同步差异

```text
$prototype-first-ui sync
对比生产环境中的 <界面> 与已批准原型，修复实现偏差。
```

## 验证

```text
$prototype-first-ui verify
对照已批准原型验证 <功能>，检查交互、文案、响应式布局和键盘可访问性。
```

## 仓库初始化

```text
$prototype-first-ui bootstrap
清理此仓库，在创建并验证外部恢复快照后，将本地 Git 历史重建到 <分支名>。保留应用功能，不改动远程仓库。
```
