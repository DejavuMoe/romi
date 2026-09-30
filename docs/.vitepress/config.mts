import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  // Repository navigation and per-tag release notes are not site pages.
  srcExclude: ['README.md', 'release-v*.md'],
  title: 'romi',
  description: 'romi：自托管的 Linux 主机监测。安装、运维与开发文档。',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#fcfcfb' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#141413' }]
  ],
  themeConfig: {
    logo: { src: '/logo.svg', alt: '' },
    siteTitle: 'romi',
    nav: [
      { text: '指南', link: '/quick-start', activeMatch: '^/(quick-start|guide|deployment)' },
      { text: '参考', link: '/requirements', activeMatch: '^/(requirements|domain|storage|security-baseline)' },
      { text: '开发', link: '/engineering', activeMatch: '^/(engineering|testing|codebase-guide|architecture|ui/|product/|bench)' },
      { text: '项目', items: [
        { text: '发布流程', link: '/release' },
        { text: '验证记录', link: '/readiness' },
        { text: '许可与标志', link: '/legal' }
      ] }
    ],
    sidebar: [
      { text: '使用指南', items: [
        { text: '介绍', link: '/' },
        { text: '快速开始', link: '/quick-start' },
        { text: '日常使用', link: '/guide' },
        { text: '部署与升级', link: '/deployment' }
      ] },
      { text: '运行参考', items: [
        { text: '功能范围', link: '/requirements' },
        { text: '节点、流量与告警', link: '/domain' },
        { text: '存储、备份与恢复', link: '/storage' },
        { text: '安全', link: '/security-baseline' }
      ] },
      { text: '参与开发', items: [
        { text: '开发指南', link: '/engineering' },
        { text: '测试', link: '/testing' },
        { text: '代码导览', link: '/codebase-guide' },
        { text: '运行架构', link: '/architecture' },
        { text: '性能测试', link: '/bench' },
        { text: '界面能力', link: '/ui/capabilities' },
        { text: '界面约束', link: '/product/constraints' },
        { text: '界面实现', link: '/ui/implementation' }
      ] },
      { text: '项目', items: [
        { text: '发布流程', link: '/release' },
        { text: '本地开发快照', link: '/local-release' },
        { text: '验证记录', link: '/readiness' },
        { text: '许可与标志', link: '/legal' }
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
    outline: { level: [2, 3], label: '本页内容' },
    navMenuLabel: '主导航',
    mobileMenuLabel: '打开导航',
    extraMenuLabel: '更多选项',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换浅色主题',
    darkModeSwitchTitle: '切换深色主题',
    returnToTopLabel: '返回顶部',
    skipToContentLabel: '跳到正文',
    notFound: { title: '页面不存在', quote: '链接可能已过期，或地址输入有误。可以回到首页，或搜索文档。', linkLabel: '回到首页', linkText: '回到首页' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/DejavuMoe/romi' }],
    editLink: { pattern: 'https://github.com/DejavuMoe/romi/edit/master/docs/:path', text: '在 GitHub 上编辑此页' },
    docFooter: { prev: '上一页', next: '下一页' },
    footer: { message: 'romi · Linux 主机监测 · MIT License', copyright: '© 2026 Dejavu Moe' }
  }
})
