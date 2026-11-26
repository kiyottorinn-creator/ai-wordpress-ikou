// check_core.js - 移行の点検係（中身）
// Nodeでもブラウザでも、同じコードで同じ結果が出るように、外部ライブラリは使いません。
// 役割は2つだけ。
//   survey()  : 移行する前の下見。WordPressの公開APIから取った記事をそのまま数える
//   inspect() : 移行した後の点検。変換後の記事（docs）を8つの軸で見る
// どちらも「人が見るしかない4つ」は別に返します。機械と人を混ぜると、どちらも効きません。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WPIkou = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 共通の小道具 ----------
  const countAll = (s, re) => ((s || '').match(re) || []).length;
  const uniq = (a) => [...new Set(a)];

  function imgSrcs(html) {
    const out = [];
    const re = /<img\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = re.exec(html || ''))) out.push(m[2] || m[3] || m[4] || '');
    return out;
  }

  function imgTags(html) {
    return (html || '').match(/<img\b[^>]*>/gi) || [];
  }

  function isNonAsciiSlug(slug) {
    let s = slug || '';
    try { s = decodeURIComponent(s); } catch (e) { /* %が混ざった壊れたslug */ }
    return /[^\x00-\x7f]/.test(s);
  }

  // ショートコード（プラグインが無いと中身が出ない記法）。
  // Markdownのリンク [文字](URL) と、注記の [1] は数えません。
  const SHORTCODE_RE = /(?<![\\!])\[\/?([a-z][a-z0-9_-]{1,30})(\s[^\]]{0,200})?\](?!\()/gi;

  const EMBED_HOSTS = [
    ['Googleフォーム・カレンダー・マップ', /docs\.google\.com|google\.com\/maps|calendar\.google\.com/i],
    ['YouTube・Vimeo', /youtube\.com|youtu\.be|vimeo\.com/i],
    ['SNSの埋め込み', /twitter\.com|x\.com\/|instagram\.com|facebook\.com/i],
    ['外部の予約・決済', /calendly|stripe\.com|square|paypal/i],
    ['その他の埋め込み', /./],
  ];

  function embedKind(src) {
    for (const [name, re] of EMBED_HOSTS) if (re.test(src || '')) return name;
    return 'その他の埋め込み';
  }

  // ---------- 移行する前の下見 ----------
  // 引数: {posts:[...], pages:[...], host:'example.com'}
  // WordPressの公開APIのレスポンスをそのまま渡します。
  function survey(input) {
    const posts = input.posts || [];
    const pages = input.pages || [];
    const host = input.host || '';
    const all = posts.concat(pages);

    let chars = 0, imgCount = 0, noAlt = 0, shortcodes = 0, tables = 0, codes = 0, h1 = 0, iframes = 0, videos = 0;
    const images = [];
    const embeds = {};
    const nonAsciiSlugs = [];
    const oldDomainImgs = [];
    const shortcodeNames = {};

    for (const p of all) {
      const html = (p.content && p.content.rendered) || '';
      chars += html.replace(/<[^>]+>/g, '').length;
      const tags = imgTags(html);
      imgCount += tags.length;
      noAlt += tags.filter((t) => !/\salt\s*=\s*("[^"]+"|'[^']+'|[^\s>"']+)/i.test(t)).length;
      for (const s of imgSrcs(html)) {
        images.push(s);
        if (/wp-content\/uploads|\/files\//.test(s)) oldDomainImgs.push(s);
      }
      for (const m of html.matchAll(SHORTCODE_RE)) {
        shortcodes++;
        shortcodeNames[m[1]] = (shortcodeNames[m[1]] || 0) + 1;
      }
      tables += countAll(html, /<table\b/gi);
      codes += countAll(html, /<pre\b/gi);
      h1 += countAll(html, /<h1\b/gi);
      const ifr = html.match(/<iframe\b[^>]*>/gi) || [];
      iframes += ifr.length;
      for (const t of ifr) {
        const src = (t.match(/src\s*=\s*("([^"]*)"|'([^']*)')/i) || [])[2] || '';
        const k = embedKind(src);
        embeds[k] = (embeds[k] || 0) + 1;
      }
      videos += countAll(html, /<video\b|<audio\b/gi);
      if (isNonAsciiSlug(p.slug)) nonAsciiSlugs.push({ slug: decodeURIComponent(p.slug || ''), link: p.link || '' });
    }

    const uniqueImages = uniq(images).length;

    // 移行作業の「項目」。時間や金額はここでは出しません（人によって違うので）
    const workItems = [
      { id: 'posts', label: '記事を移す', unit: '本', n: posts.length, auto: '台本が運ぶ', human: '抜けていないかを一覧で確認' },
      { id: 'pages', label: '固定ページを移す', unit: '本', n: pages.length, auto: '台本が運ぶ', human: '問い合わせ・会社概要は1枚ずつ目で見る' },
      { id: 'images', label: '画像を移す', unit: '点', n: uniqueImages, auto: '台本が落として置き換える', human: '落とせなかったものだけ確認' },
      { id: 'redirects', label: 'URLが変わる記事の転送を書く', unit: '本', n: all.length, auto: '台本が転送表を作る', human: '主要ページだけ実際に開いて確認' },
      { id: 'nonascii', label: 'URLに日本語が入った記事', unit: '本', n: nonAsciiSlugs.length, auto: 'ASCIIに付け替える', human: '検索流入が多い記事は個別に相談' },
      { id: 'shortcodes', label: 'ショートコードを置き換える', unit: '箇所', n: shortcodes, auto: '一覧にする', human: '置き換え方を1種類ずつ決める' },
      { id: 'embeds', label: '埋め込み（動画・地図・フォーム）', unit: '箇所', n: iframes + videos, auto: '場所を印にして残す', human: '新サイトで表示を1つずつ見る' },
      { id: 'tables', label: '表の崩れを見る', unit: '個', n: tables, auto: 'Markdownの表に組み直す', human: '見出し行がある表だけ確認' },
      { id: 'noalt', label: '画像の説明文（alt）が無い', unit: '点', n: noAlt, auto: '一覧にする', human: '書くかどうかを決める' },
      { id: 'h1', label: '本文の中に大見出し（h1）がある', unit: '箇所', n: h1, auto: '一覧にする', human: '見出しの段を決める' },
    ];

    return {
      host,
      counts: {
        posts: posts.length,
        pages: pages.length,
        text_chars: chars,
        images_in_body: imgCount,
        images_unique: uniqueImages,
        images_no_alt: noAlt,
        images_on_old_domain: oldDomainImgs.length,
        shortcodes,
        shortcode_names: shortcodeNames,
        tables,
        code_blocks: codes,
        h1_in_body: h1,
        iframes,
        media_tags: videos,
        slug_non_ascii: nonAsciiSlugs.length,
      },
      embeds,
      non_ascii_slugs: nonAsciiSlugs.slice(0, 50),
      work_items: workItems,
      human_checks: HUMAN_CHECKS,
    };
  }

  // ---------- 移行した後の点検（機械で見る8軸） ----------
  // docs    : convert.js が出した out/docs.json
  // haveImg : 手元にある画像ファイル名の集合（Set か 配列）
  // redirects: out/redirects.json
  function inspect(docs, opts) {
    opts = opts || {};
    const have = opts.haveImages instanceof Set ? opts.haveImages : new Set(opts.haveImages || []);
    const redirectFrom = new Set((opts.redirects || []).map((r) => r.from));
    // 移行係のルールで「依頼主に聞く（ask）」にしたものは、直し忘れではなく返事待ちです。
    // 同じ山に積むと、本当に直す所が見えなくなります。
    const askRules = []
      .concat(((opts.rules || {}).embeds || []).filter((r) => r.as === 'ask'))
      .concat(((opts.rules || {}).images || []).filter((r) => r.as === 'ask'));
    const waiting = { id: 'waiting_client', name: '依頼主の返事を待っている（移行係がaskにしたもの）', items: [] };
    const isAsk = (url) => askRules.some((r) => { try { return new RegExp(r.match, 'i').test(String(url)); } catch (e) { return false; } });
    const axes = [
      { id: 'img_old_domain', name: '旧サイトのままの画像リンクが残っている', items: [] },
      { id: 'img_missing', name: '本文が指している画像が手元に無い', items: [] },
      { id: 'img_no_alt', name: '画像の説明文（alt）が空', items: [] },
      { id: 'redirect_missing', name: 'URLが変わるのに転送表に無い', items: [] },
      { id: 'shortcode_left', name: 'ショートコードの残骸', items: [] },
      { id: 'embed_lost', name: '埋め込みが本文から消えている', items: [] },
      { id: 'heading_broken', name: '見出しが壊れている（本文中のh1・段の飛び）', items: [] },
      { id: 'thin_doc', name: '中身が足りない（タイトル空・本文が極端に短い・公開日が無い）', items: [] },
    ];
    const by = {};
    for (const a of axes) by[a.id] = a;

    for (const d of docs) {
      const md = d.markdown || '';

      // 1. 旧サイトのままの画像リンク
      for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const src = m[1];
        if (!/^https?:\/\//i.test(src)) continue;
        if (isAsk(src)) waiting.items.push({ slug: d.slug, src, kind: '画像' });
        else by.img_old_domain.items.push({ slug: d.slug, src });
      }

      // 2. 手元に無い画像
      for (const m of md.matchAll(/!\[[^\]]*\]\((\/images\/[^)]+)\)/g)) {
        const file = m[1].replace('/images/', '');
        if (have.size && !have.has(file)) by.img_missing.items.push({ slug: d.slug, file });
      }
      if (d.eyecatch && d.eyecatch.startsWith('/images/') && have.size && !have.has(d.eyecatch.replace('/images/', ''))) {
        by.img_missing.items.push({ slug: d.slug, file: d.eyecatch.replace('/images/', ''), where: 'アイキャッチ' });
      }

      // 3. altが空の画像
      for (const m of md.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
        if (!m[1].trim()) by.img_no_alt.items.push({ slug: d.slug, src: m[2] });
      }

      // 4. 転送表の抜け
      if (d.oldLink) {
        let oldPath = d.oldLink;
        try { oldPath = new URL(d.oldLink).pathname; } catch (e) { /* 相対URLのとき */ }
        if (oldPath !== d.newPath && !redirectFrom.has(oldPath)) {
          by.redirect_missing.items.push({ slug: d.slug, from: oldPath, to: d.newPath });
        }
      }

      // 5. ショートコードの残骸
      for (const m of md.matchAll(SHORTCODE_RE)) {
        by.shortcode_left.items.push({ slug: d.slug, code: m[0].slice(0, 60) });
      }

      // 6. 埋め込みが消えた（印のコメントだけ残っている箇所を数える）
      for (const m of md.matchAll(/<!--\s*(?:埋め込み|要確認|video|audio)[^>]*?:\s*([^\s>]+)\s*-->/g)) {
        if (isAsk(m[1])) waiting.items.push({ slug: d.slug, src: m[1], kind: '埋め込み' });
        else by.embed_lost.items.push({ slug: d.slug, src: m[1], kind: embedKind(m[1]) });
      }

      // 7. 見出しの壊れ
      const levels = [...md.matchAll(/^(#{1,6})\s+\S/gm)].map((m) => m[1].length);
      if (levels.includes(1)) by.heading_broken.items.push({ slug: d.slug, why: '本文の中に大見出し（#）がある' });
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] - levels[i - 1] >= 2) {
          by.heading_broken.items.push({ slug: d.slug, why: `見出しの段が飛んでいる（${'#'.repeat(levels[i - 1])} のつぎが ${'#'.repeat(levels[i])}）` });
          break;
        }
      }

      // 8. 中身が足りない
      const why = [];
      if (!String(d.title || '').trim()) why.push('タイトルが空');
      if (md.replace(/\s/g, '').length < 80) why.push('本文が80字未満');
      if (!d.date) why.push('公開日が無い');
      if (why.length) by.thin_doc.items.push({ slug: d.slug, why: why.join(' / ') });
    }

    const summary = axes.map((a) => ({ id: a.id, name: a.name, count: a.items.length }));
    return {
      total: axes.reduce((s, a) => s + a.items.length, 0),
      summary,
      axes,
      waiting_client: { count: waiting.items.length, items: waiting.items },
      human_checks: HUMAN_CHECKS,
    };
  }

  // ---------- 人が見るしかない4つ ----------
  const HUMAN_CHECKS = [
    {
      id: 'embed_display',
      name: '埋め込みが新サイトで表示されているか',
      why: '動画・地図・フォームは、入っている場所までは機械で分かります。表示できているかは画面を見ないと分かりません。',
      how: '点検係が出した一覧の記事を、新サイトで上から順に開く。印のコメントだけ残っている箇所を埋める。',
    },
    {
      id: 'form_function',
      name: 'プラグインでできていた機能の代わりが決まっているか',
      why: '問い合わせフォーム・予約・会員機能は、WordPressのプラグインが動かしています。記事の文字を運んでも、機能は運べません。',
      how: '固定ページを1枚ずつ開いて、動いていた機能を書き出す。代わりの外部サービスか、作るかを決める。',
    },
    {
      id: 'layout_meaning',
      name: '表と画像の並びで意味が変わっていないか',
      why: '見出し行が無い表、文章の横に回り込んでいた画像は、組み直すと順番が変わります。数は合っていても、読み方が変わることがあります。',
      how: '表のある記事と、画像が3枚以上ある記事だけを抜き出して、旧サイトと並べて見る。',
    },
    {
      id: 'seo_priority',
      name: 'URLが変わる記事のうち、どれを優先して確かめるか',
      why: '転送表は全件つくれます。でも、検索からの流入が多い記事が転送できているかは、サーチコンソールを見る人しか分かりません。',
      how: '流入上位20本だけ、旧URLを実際に開いて新URLに着くか確認する。残りは転送表に任せる。',
    },
  ];

  return { survey, inspect, HUMAN_CHECKS, helpers: { imgSrcs, imgTags, isNonAsciiSlug, embedKind, SHORTCODE_RE } };
});
