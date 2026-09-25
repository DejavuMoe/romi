import { defineConfig } from 'vitepress'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const docsRoot = fileURLToPath(new URL('../', import.meta.url))
const linkedData = [
  'experiments/documentation.json',
  'experiments/runtime-cleanup.json',
  'ui/v12-responsive.json',
  'ui/v12-navigation.json',
  'ui/v12-interactions.json'
]

export default defineConfig({
  lang: 'zh-CN',
  title: 'romi 文档',
  description: 'romi：自托管的 Linux 主机监测。安装、运维与开发文档。',
  head: [['meta', { name: 'theme-color', content: '#205ea6' }]],
  async buildEnd({ outDir }) {
    for (const file of linkedData) {
      const target = join(outDir, file)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(docsRoot, file), target)
    }
  },
  themeConfig: {
    siteTitle: 'romi 文档',
    nav: [
      { text: '快速开始', link: '/quick-start' },
      { text: '部署', link: '/deployment' },
      { text: '功能', link: '/requirements' },
      { text: '开发', link: '/engineering' },
      { text: '许可', link: '/legal' }
    ],
    sidebar: [
      { text: '开始', items: [
        { text: '介绍', link: '/' },
        { text: '快速开始', link: '/quick-start' },
        { text: '部署与升级', link: '/deployment' },
        { text: '功能范围', link: '/requirements' }
      ] },
      { text: '运维参考', items: [
        { text: '存储、备份与恢复', link: '/storage' },
        { text: '安全边界', link: '/security-baseline' },
        { text: '领域规则', link: '/domain' },
        { text: '运行架构', link: '/architecture' },
        { text: '容量基准', link: '/bench' }
      ] },
      { text: '开发', items: [
        { text: '开发流程', link: '/engineering' },
        { text: '测试', link: '/testing' },
        { text: '代码导览', link: '/codebase-guide' },
        { text: '界面能力', link: '/ui/capabilities' },
        { text: '界面约束', link: '/product/constraints' },
        { text: '界面契约', link: '/ui/implementation' },
        { text: '发布流程', link: '/release' },
        { text: '本地快照', link: '/local-release' }
      ] },
      { text: '项目', items: [
        { text: '验收状态', link: '/readiness' },
        { text: '许可', link: '/legal' },
        { text: '文档消融', link: '/experiments/documentation' },
        { text: '运行代码清理消融', link: '/experiments/runtime-cleanup' }
      ] }
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '重置搜索',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有匹配文档',
                footer: {
                  selectText: '选择', selectKeyAriaLabel: '回车',
                  navigateText: '导航', navigateUpKeyAriaLabel: '上箭头',
                  navigateDownKeyAriaLabel: '下箭头', closeText: '关闭',
                  closeKeyAriaLabel: 'Esc'
                }
              }
            }
          }
        }
      }
    },
    externalLinkIcon: true,
    outline: { label: '本页目录' },
    navMenuLabel: '主导航',
    mobileMenuLabel: '打开导航',
    extraMenuLabel: '更多选项',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换浅色主题',
    darkModeSwitchTitle: '切换深色主题',
    returnToTopLabel: '返回顶部',
    skipToContentLabel: '跳到正文',
    socialLinks: [{ icon: 'github', link: 'https://github.com/DejavuMoe/romi' }],
    editLink: { pattern: 'https://github.com/DejavuMoe/romi/edit/master/docs/:path', text: '在 GitHub 上编辑此页' },
    docFooter: { prev: '上一页', next: '下一页' },
    footer: { message: '以 MIT 协议发布', copyright: 'Copyright © 2026 Dejavu Moe' }
  }
})
