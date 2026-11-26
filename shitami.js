// shitami.js - ブラウザの中だけで、WordPressサイトの下見をする
// 入れたURLはどこにも送りません。あなたのブラウザが、相手のサイトの公開APIを直接読みます。
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const SAMPLE = 20; // 読む本数。相手のサーバーに負担をかけないように、最新だけを読みます

  function normalize(input) {
    let v = String(input || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try { return new URL(v).origin; } catch (e) { return ''; }
  }

  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const total = parseInt(res.headers.get('x-wp-total') || '0', 10) || null;
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return { json: await res.json(), total };
  }

  function row(tbody, cells, strong) {
    const tr = el('tr');
    cells.forEach((c, i) => {
      const td = el(i === 0 && strong ? 'th' : 'td');
      if (c instanceof Node) td.appendChild(c); else td.textContent = c;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
    return tr;
  }

  async function run(origin) {
    const out = $('#result');
    out.innerHTML = '';
    const log = el('p', 'log', '公開APIを見にいっています…');
    out.appendChild(log);

    let root;
    try {
      root = (await getJSON(origin + '/wp-json/')).json;
    } catch (e) {
      out.innerHTML = '';
      const box = el('div', 'bad');
      box.appendChild(el('p', null, '公開APIが読めませんでした（' + (e.status || e.message) + '）。'));
      const ul = el('ul');
      ['WordPressで作られていないサイトかもしれません',
       'プラグインやサーバー側の設定で、公開APIが閉じられていることがあります',
       'その場合は、管理画面の「ツール > エクスポート」で書き出したXMLから移せます'].forEach((t) => ul.appendChild(el('li', null, t)));
      box.appendChild(ul);
      out.appendChild(box);
      return;
    }

    log.textContent = '投稿の種類を調べています…';
    let types = {};
    try { types = (await getJSON(origin + '/wp-json/wp/v2/types')).json; } catch (e) { /* 閉じていることがある */ }

    const SKIP = /^(attachment|nav_menu_item|wp_block|wp_template|wp_template_part|wp_global_styles|wp_navigation|wp_font_family|wp_font_face|wp_pattern_category)$/;
    const typeRows = [];
    for (const [slug, t] of Object.entries(types)) {
      const base = (t && t.rest_base) || slug;
      if (/\(/.test(base)) continue;
      if (SKIP.test(slug)) continue;
      try {
        const r = await getJSON(origin + '/wp-json/wp/v2/' + base + '?per_page=1');
        typeRows.push({ slug, name: (t && t.name) || slug, base, count: r.total || 0, readable: true });
      } catch (e) {
        typeRows.push({ slug, name: (t && t.name) || slug, base, count: null, readable: false, status: e.status });
      }
    }

    log.textContent = '最新の記事を' + SAMPLE + '本読んで、中身を数えています…';
    let posts = [], pages = [], postTotal = 0, pageTotal = 0;
    try { const r = await getJSON(origin + '/wp-json/wp/v2/posts?per_page=' + SAMPLE + '&_embed=1'); posts = r.json; postTotal = r.total || posts.length; } catch (e) {}
    try { const r = await getJSON(origin + '/wp-json/wp/v2/pages?per_page=' + SAMPLE); pages = r.json; pageTotal = r.total || pages.length; } catch (e) {}

    if (!posts.length && !pages.length) {
      out.innerHTML = '';
      out.appendChild(el('div', 'bad', '公開APIは開いていましたが、記事が読めませんでした。非公開か、別の投稿タイプに入っている可能性があります。'));
      return;
    }

    const s = WPIkou.survey({ posts, pages, host: new URL(origin).host });
    const sampled = posts.length + pages.length;
    const totalAll = (postTotal || 0) + (pageTotal || 0);
    const scale = sampled ? totalAll / sampled : 1;

    out.innerHTML = '';
    const h = el('h3', null, (root.name || new URL(origin).host) + ' の下見');
    out.appendChild(h);

    const p1 = el('p', 'note');
    p1.textContent = '最新 ' + sampled + '本（記事' + posts.length + '＋固定ページ' + pages.length + '）を実際に読んで数えました。'
      + '全体の本数は公開APIが返した総数です。「全体の見込み」は、読んだ' + sampled + '本の平均を全' + totalAll + '本にかけた数で、実測ではありません。';
    out.appendChild(p1);

    // 本数
    const t1 = el('table');
    const tb1 = el('tbody');
    t1.appendChild(tb1);
    row(tb1, ['移行の対象になる本数', String(totalAll) + '本'], true);
    for (const t of typeRows) {
      row(tb1, ['　' + t.name + '（' + t.base + '）', t.readable ? t.count + '本' : 'ログインが必要（' + t.status + '）']);
    }
    out.appendChild(t1);

    // プラグインの痕跡
    const ns = (root.namespaces || []).join(' ').toLowerCase();
    const hints = [
      ['contact-form-7|wpcf7', '問い合わせフォーム', 'フォームは運べません。外部サービスか作り直しになります'],
      ['wc/|wc-', 'ネットショップ（WooCommerce）', '商品・注文・会員が絡みます。別の見積もりにします'],
      ['yoast|rankmath', '検索向け設定', 'タイトルと説明文を新サイトに移す作業が増えます'],
      ['jetpack', 'Jetpack', '画像が別のドメインから配られていることがあります'],
      ['elementor', 'ページ作成プラグイン（Elementor）', '本文が独自の形です。手で組み直す覚悟が要ります'],
      ['acf', '追加の入力欄（ACF）', '本文以外の項目があります。移行先の項目設計が増えます'],
      ['polylang|wpml', '多言語', '言語ごとにURLが分かれています'],
    ];
    const found = hints.filter(([re]) => new RegExp(re).test(ns));
    if (found.length) {
      out.appendChild(el('h4', null, 'プラグインの痕跡'));
      const ul = el('ul');
      for (const [, label, memo] of found) ul.appendChild(el('li', null, label + ' — ' + memo));
      out.appendChild(ul);
    }

    // 数えたもの
    out.appendChild(el('h4', null, '読んだ' + sampled + '本の中身'));
    const t2 = el('table');
    const tb2 = el('tbody');
    t2.appendChild(el('thead')).appendChild(row(el('tbody'), ['項目', '読んだ分', '全体の見込み']));
    t2.appendChild(tb2);
    const c = s.counts;
    const est = (n) => Math.round(n * scale).toLocaleString();
    const lines = [
      ['本文の文字数', c.text_chars.toLocaleString() + '字', est(c.text_chars) + '字'],
      ['本文の画像', c.images_unique + '点', est(c.images_unique) + '点'],
      ['説明文（alt）が無い画像', c.images_no_alt + '点', est(c.images_no_alt) + '点'],
      ['URLに日本語が入った記事', c.slug_non_ascii + '本', est(c.slug_non_ascii) + '本'],
      ['埋め込み（動画・地図・フォーム）', (c.iframes + c.media_tags) + '箇所', est(c.iframes + c.media_tags) + '箇所'],
      ['表', c.tables + '個', est(c.tables) + '個'],
      ['本文の中の大見出し（h1）', c.h1_in_body + '箇所', est(c.h1_in_body) + '箇所'],
      ['ショートコード', c.shortcodes + '箇所', est(c.shortcodes) + '箇所'],
    ];
    for (const l of lines) row(tb2, l);
    out.appendChild(t2);

    if (c.slug_non_ascii) {
      out.appendChild(el('h4', null, 'URLに日本語が入っている記事（転送が必要）'));
      const ul = el('ul', 'slugs');
      for (const x of s.non_ascii_slugs.slice(0, 10)) ul.appendChild(el('li', null, x.slug));
      out.appendChild(ul);
    }

    // 作業の項目
    out.appendChild(el('h4', null, '見積もりに並ぶ項目（数量は読んだ分の実数）'));
    const t3 = el('table');
    const tb3 = el('tbody');
    t3.appendChild(el('thead')).appendChild(row(el('tbody'), ['項目', '数量', '機械が終わらせる所', '人が見る所']));
    t3.appendChild(tb3);
    for (const w of s.work_items) row(tb3, [w.label, w.n + w.unit, w.auto, w.human]);
    out.appendChild(t3);

    out.appendChild(el('h4', null, '機械では決められない4つ'));
    const ul4 = el('ul');
    for (const hc of s.human_checks) {
      const li = el('li');
      li.appendChild(el('strong', null, hc.name));
      li.appendChild(el('span', null, ' — ' + hc.how));
      ul4.appendChild(li);
    }
    out.appendChild(ul4);

    const warn = el('p', 'note', 'この下見は本数と箇所数を数えるだけです。所要時間と金額は入っていません。移すかどうか、いくらで受けるかは、あなたが決めることです。');
    out.appendChild(warn);
  }

  window.addEventListener('DOMContentLoaded', () => {
    const form = $('#shitami');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const origin = normalize($('#site').value);
      if (!origin) { $('#result').innerHTML = '<div class="bad">URLの形が読めませんでした。https:// から入れてください。</div>'; return; }
      $('#go').disabled = true;
      try { await run(origin); }
      catch (e) { $('#result').innerHTML = '<div class="bad">途中で止まりました: ' + String(e.message) + '</div>'; }
      finally { $('#go').disabled = false; }
    });
    document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      $('#site').value = b.getAttribute('data-sample');
      form.dispatchEvent(new Event('submit'));
    }));
  });
})();
