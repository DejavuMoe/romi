<script setup lang="ts">
import { withBase } from 'vitepress'
</script>

<template>
  <div class="romi-home">
    <section class="home-intro" aria-labelledby="intro-title">
      <div>
        <p class="eyebrow">自托管的 Linux 主机监测</p>
        <h1 id="intro-title">多台主机，<br>在一处查看。</h1>
        <p class="intro-copy">查看服务器的资源、流量与在线状态，回看历史，接收离线提醒。一个 Hub、一份数据库，部署在你自己的服务器上。</p>
        <div class="home-actions">
          <a class="home-button primary" :href="withBase('/quick-start.html')">开始安装 <span aria-hidden="true">→</span></a>
          <a class="home-button" :href="withBase('/guide.html')">阅读使用指南</a>
        </div>
        <p class="home-meta">开源 / MIT <span>Rust · DuckDB</span> Linux x86_64 / ARM64</p>
      </div>
      <figure class="home-topology">
        <div class="topology-heading"><span>romi 的工作方式</span><span>Agent → Hub</span></div>
        <div class="topology-nodes" aria-label="多台 Linux 主机运行 Agent">
          <span>Linux <small>Agent</small></span><span>Linux <small>Agent</small></span><span>Linux <small>Agent</small></span>
        </div>
        <div class="topology-lines" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="topology-hub">
          <img :src="withBase('/logo.svg')" width="44" height="44" alt="">
          <div><strong>romi <span>Hub</span></strong><small>实时状态 · 历史 · 通知</small></div>
          <span class="db-label">DuckDB</span>
        </div>
        <figcaption>Agent 采集并上报，Hub 保存数据。<br>通过浏览器查看状态、管理节点。</figcaption>
      </figure>
    </section>
    <section class="home-section" aria-labelledby="features-title">
      <div class="section-heading"><p class="eyebrow">日常使用</p><h2 id="features-title">从当前状态，看到历史变化。</h2></div>
      <div class="home-features">
        <article><span class="section-number">01</span><h3>资源与流量</h3><p>CPU、内存、磁盘和网络速率集中查看。按节点记录累计流量、账期用量与到期日期。</p><a :href="withBase('/guide.html#查看节点与流量')">查看节点 <span aria-hidden="true">↗</span></a></article>
        <article><span class="section-number">02</span><h3>监测与提醒</h3><p>从指定主机探测 TCP 延迟与丢包，通过 Telegram 或 Webhook 接收离线、恢复和到期提醒。</p><a :href="withBase('/guide.html#配置监测与通知')">配置监测 <span aria-hidden="true">↗</span></a></article>
        <article><span class="section-number">03</span><h3>公开状态页</h3><p>选择需要展示的节点，用卡片或列表分享状态。匿名访客看不到 IP、主机名、备注和凭据。</p><a :href="withBase('/guide.html#开放状态页')">设置公开范围 <span aria-hidden="true">↗</span></a></article>
      </div>
    </section>
    <section class="home-reading home-section" aria-labelledby="reading-title">
      <div><p class="eyebrow">文档</p><h2 id="reading-title">按你要做的事，<br>找到下一步。</h2><p>第一次安装从快速开始读起。已有实例可以直接查看运维与开发参考。</p></div>
      <div class="reading-links">
        <a :href="withBase('/deployment.html')"><span><strong>部署与升级</strong><small>HTTPS、系统服务、Agent Docker 与升级步骤</small></span><span aria-hidden="true">→</span></a>
        <a :href="withBase('/storage.html')"><span><strong>存储与备份</strong><small>历史保留、备份格式、恢复与数据库维护</small></span><span aria-hidden="true">→</span></a>
        <a :href="withBase('/engineering.html')"><span><strong>参与开发</strong><small>搭建环境、运行检查、提交改动</small></span><span aria-hidden="true">→</span></a>
      </div>
    </section>
    <aside class="home-scope">romi 专注 Linux 主机监测。Agent 只采集指标和执行 TCP 探测，不提供远程终端或命令执行。<a :href="withBase('/requirements.html')">了解功能范围 →</a></aside>
  </div>
</template>
