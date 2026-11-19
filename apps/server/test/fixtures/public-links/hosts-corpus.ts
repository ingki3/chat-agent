/**
 * Inputs for the external-address notice (#204): every reproduction from the PR #209 reviews (rounds 1–7) and
 * ordinary HTML and markdown. `target`: the host a browser (or a reader) would actually go to — the notice must
 * always list it. `hosts-prior.json` holds what each earlier implementation of the notice reported for the same
 * input (generated once from those commits); the current one must report all of that too.
 */
const CDN = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";

export const HOSTS_CORPUS: { name: string; content: string; title?: string; target: string[] }[] = [
  // Round 1–2
  {
    name: "cdn + image + email/phone",
    content: `<p>mom@example.com, 010-1234-5678</p><script src="${CDN}"></script><img src="https://images.example.org/a.png">`,
    target: ["cdn.jsdelivr.net", "images.example.org"],
  },
  {
    name: "src= then newline and 20 spaces",
    content: `<script src=\n${" ".repeat(20)}"${CDN}"></script>`,
    target: ["cdn.jsdelivr.net"],
  },
  {
    name: "spaced attributes over lines",
    content: `<img\n  src\n  =\n  'https://images.example.org/a.png'><link href =  "//fonts.example.com/x.css">`,
    target: ["images.example.org", "fonts.example.com"],
  },
  // Round 3
  {
    name: "vertical tab before the CDN",
    content: `<script src="\u000b${CDN}"></script>`,
    target: ["cdn.jsdelivr.net"],
  },
  {
    name: "=https:// relative value",
    content: '<script src="=https://images.example.org/file.js"></script>',
    target: ["images.example.org"],
  },
  // Round 4
  {
    name: "2048 spaces before the CDN",
    content: `<script src="${" ".repeat(2048)}${CDN}"></script>`,
    target: ["cdn.jsdelivr.net"],
  },
  {
    name: "<code>url(</code> then a link",
    content: '<p><code>url(</code> 예시 <a href="https://docs.example.org/css">문서</a></p>',
    target: ["docs.example.org"],
  },
  {
    name: "srcset with a comma in its URL",
    content: '<img srcset="https://img.example/x.png?urls=/a,//thumb.example.org/b 1x">',
    target: ["img.example"],
  },
  // Round 5
  {
    name: '<code>style="</code> then an image',
    content: '<p><code>style="</code></p><img src="https://img.example/p.png">',
    target: ["img.example"],
  },
  {
    name: "SVG fill url()",
    content: '<svg><rect fill="url(https://paint.example/colors.svg#blue)"/></svg>',
    target: ["paint.example"],
  },
  {
    name: "<style> with a 1000-character attribute",
    content: `<style data-note="${"n".repeat(1000)}">p{background:url(https://long-style.example/p.png)}</style>`,
    target: ["long-style.example"],
  },
  {
    name: "url() after 64 KiB of style",
    content: `<div style="${"color:red;".repeat(7000)}background:url(//big-style.example/b.png)">`,
    target: ["big-style.example"],
  },
  {
    name: "srcset bad((",
    content: '<img srcset="a.png bad((x), https://img.example/real.png 2x">',
    target: ["img.example"],
  },
  // Round 6
  {
    name: "Unicode host",
    content: "<a href='https://도서관.example.org/a'>",
    target: ["xn--zb0b81k2qm.example.org"],
  },
  { name: "userinfo", content: "https://reader@docs.example.org/x", target: ["docs.example.org"] },
  { name: "extra slash", content: "https:///docs.example.org/x", target: ["docs.example.org"] },
  {
    name: "newline inside a host",
    content: '<img src="https://docs.exa\nmple.org/p.png">',
    target: ["docs.example.org"],
  },
  { name: "port", content: "https://docs.example.org:8443/x", target: ["docs.example.org"] },
  // Round 7
  {
    name: "unquoted src, alt on the next line",
    content: "<img src=https://cdn.example.org\nalt=logo>",
    target: ["cdn.example.org"],
  },
  { name: "! after a bare host", content: "참고 https://docs.example.org!", target: ["docs.example.org"] },
  {
    name: "&#47; for the path slash",
    content: '<a href="https://docs.example.org&#47;help">도움말</a>',
    target: ["docs.example.org"],
  },
  {
    name: "comma in userinfo",
    content: "https://last,first@docs.example.org/help",
    target: ["docs.example.org"],
  },
  // Ordinary documents
  {
    name: "ordinary HTML",
    content: `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto"><style>body{background:url('https://bg.example.net/a.jpg')}</style></head><body><h1>제목</h1><p><a href="https://www.example.com/page?x=1#y">링크</a>, 자세한 건 https://docs.example.org/guide 참고.</p><img srcset="https://img1.example/a.png 1x, https://img2.example/b.png 2x"><script src="${CDN}"></script></body></html>`,
    target: [
      "fonts.googleapis.com",
      "bg.example.net",
      "www.example.com",
      "docs.example.org",
      "img1.example",
      "img2.example",
      "cdn.jsdelivr.net",
    ],
  },
  {
    name: "ordinary markdown",
    content:
      "# 정리\n\n- [공식 문서](https://docs.example.org/a)\n- ![그림](https://m.example/p.png)\n- 원문: <https://news.example.co.kr/1>\n\n```js\n// 주석\nfetch('//api.example.io/v1')\n```\n",
    title: "출처 https://title.example.net",
    target: ["docs.example.org", "m.example", "news.example.co.kr", "api.example.io", "title.example.net"],
  },
];
