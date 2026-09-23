const root = document.documentElement;
const theme = localStorage.getItem('romi-docs-theme');
if (theme === 'dark') root.classList.add('dark');

document.querySelector('.theme-trigger').addEventListener('click', () => {
  root.classList.toggle('dark');
  localStorage.setItem('romi-docs-theme', root.classList.contains('dark') ? 'dark' : 'light');
});

const menuButton = document.querySelector('.menu-trigger');
const menu = document.querySelector('.mobile-menu');
menuButton.addEventListener('click', () => {
  const open = menu.hidden;
  menu.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
});

const dialog = document.querySelector('.search-dialog');
const input = dialog.querySelector('input');
const results = dialog.querySelector('.search-results');
const pages = [
  { title: '概览', section: '文档', href: 'index.html' },
  { title: '部署', section: '开始使用', href: 'guide.html' },
  { title: '功能范围', section: '产品', href: 'features.html' },
  { title: '备份与恢复', section: '运维', href: 'storage.html' },
  { title: '安全边界', section: '运维', href: 'security.html' },
  { title: '开发流程', section: '开发', href: 'engineering.html' },
  { title: '发布流程', section: '开发', href: 'release.html' },
];
function search() {
  const matches = pages.filter(page => page.title.includes(input.value.trim()));
  results.replaceChildren();
  for (const page of matches) {
    const link = document.createElement('a');
    link.href = page.href;
    link.textContent = page.title;
    const section = document.createElement('small');
    section.textContent = page.section;
    link.append(section);
    results.append(link);
  }
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.textContent = '没有匹配文档';
    results.append(empty);
  }
}
document.querySelector('.search-trigger').addEventListener('click', () => {
  input.value = '';
  search();
  dialog.showModal();
  input.focus();
});
input.addEventListener('input', search);
