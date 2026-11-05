/**
 * Strip remote-resource references out of a CSS string while keeping the
 * rest of the declarations intact:
 * - `@import` rules (they fetch remote stylesheets, a Referer beacon),
 * - `url(...)` tokens (background-image / @font-face beacons), and
 * - declarations left dangling with an empty value by the above.
 * The leftover declarations keep rendering. Applied to <style> blocks and
 * inline style="" attributes.
 */
const stripRemoteCssUrls = (css: string): string =>
  css
    .replace(/@import\s[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)[\s\S]*?\1\s*\)/gi, "")
    .replace(/(^|;)\s*[a-zA-Z-]+\s*:\s*(?=;|$)/gi, "$1");

/**
 * Strip dangerous elements and attributes from an HTML string using
 * DOMParser — no external library required.
 *
 * The email viewer already runs inside a sandboxed iframe without
 * `allow-scripts`, so JS cannot execute regardless. This function is
 * defense-in-depth: it removes script tags, event handlers, and
 * dangerous URI schemes before the HTML is injected into the iframe.
 * The iframe uses `allow-popups allow-popups-to-escape-sandbox` so that
 * links opened in new tabs escape the sandbox and render normally.
 *
 * Remote-resource fetches are Referer beacons: besides the per-<img>
 * referrerpolicy, document-scoped `<meta name="referrer">` (added by
 * processHtmlForViewer) plus <link> removal and url()/@import stripping in
 * this function close the remaining vectors (CSS, <input type=image>,
 * <video poster>, <table background>, srcset).
 */
const sanitizeEmailHtml = (html: string): string => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Remove elements that can execute code or load external resources silently.
  // <link> is dropped outright: a mail has no legitimate external stylesheet,
  // and a <link rel="stylesheet"> fetch would send the app origin as Referer.
  const dangerous = ["script", "iframe", "object", "embed", "applet", "base", "link"];
  dangerous.forEach((tag) => {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  });

  // A mail-authored <meta name="referrer"> would override the viewer's own
  // policy (the last meta wins), so drop those; processHtmlForViewer re-adds
  // no-referrer at the top of the built document.
  doc.querySelectorAll("meta").forEach((meta) => {
    if ((meta.getAttribute("name") ?? "").toLowerCase() === "referrer") {
      meta.remove();
    }
  });

  // Strip remote-resource references out of <style> blocks and inline style=""
  // attributes while keeping the rest of the CSS: @import rules fetch remote
  // stylesheets and url(...) carries background-image / @font-face beacons.
  // Dropping whole style blocks would break legitimate mail rendering, so this
  // is surgical.
  doc.querySelectorAll("style").forEach((style) => {
    style.textContent = stripRemoteCssUrls(style.textContent ?? "");
  });

  // Strip dangerous attributes on every element
  const DANGEROUS_ATTR = /^on/i; // onclick, onerror, onload, ...
  // Per the WHATWG URL standard a parser strips leading C0 controls and
  // space, then removes every ASCII tab, LF and CR from anywhere in the
  // input, *before* reading the scheme. So `java<TAB>script:` and
  // `\x01javascript:` are both `javascript:` to the browser, and the old
  // `^\s*` anchors modeled neither half. Normalize the way the parser does,
  // then anchor the scheme tests at position 0.
  const normalizeUriForSchemeTest = (value: string): string =>
    value.replace(/^[\x00-\x20]+/, "").replace(/[\x09\x0a\x0d]/g, "");
  const SCRIPT_URI = /^(javascript|vbscript):/i;
  const HREF_DATA_URI = /^data:/i; // dangerous in href/action (HTML data: can run JS); harmless as <img src>
  // SVG <a xlink:href> is the XML-namespaced equivalent of HTML href, and
  // <button formaction> is the action equivalent for form submission. Both
  // accept the same URI schemes as href/action and need the same scrubbing.
  // srcset, poster, and background are image-source attributes like src
  // (<picture><source srcset>, <video poster>, <table background>) and get
  // the same script-scheme scrub; data: stays allowed as an inert image
  // source, exactly as for <img src>.
  const SCRIPT_URI_ATTRS = new Set([
    "href",
    "src",
    "srcset",
    "poster",
    "background",
    "action",
    "xlink:href",
    "formaction",
  ]);
  const DATA_URI_ATTRS = new Set([
    "href",
    "action",
    "xlink:href",
    "formaction",
  ]);
  // srcset is a comma-separated candidate list ("url 1x, url 2x"), so a
  // script-scheme URL can hide after the first candidate — test each one.
  const hasScriptScheme = (name: string, value: string): boolean =>
    name === "srcset"
      ? value
          .split(",")
          .some((candidate) =>
            // Normalize before splitting off the descriptor: the parser
            // strips tabs/LF/CR from the URL itself, so a tab can sit inside
            // the scheme and splitting on whitespace first would cut it off.
            SCRIPT_URI.test(
              normalizeUriForSchemeTest(candidate).trim().split(/\s+/)[0] ?? ""
            )
          )
      : SCRIPT_URI.test(normalizeUriForSchemeTest(value));

  doc.querySelectorAll("*").forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      if (DANGEROUS_ATTR.test(attr.name)) {
        el.removeAttribute(attr.name);
      } else if (attr.name === "style") {
        // Strip remote CSS references out of inline styles, keeping the rest.
        const cleaned = stripRemoteCssUrls(attr.value);
        if (!cleaned.trim()) el.removeAttribute(attr.name);
        else el.setAttribute(attr.name, cleaned);
      } else if (
        SCRIPT_URI_ATTRS.has(attr.name) &&
        hasScriptScheme(attr.name, attr.value)
      ) {
        el.removeAttribute(attr.name);
      } else if (
        DATA_URI_ATTRS.has(attr.name) &&
        HREF_DATA_URI.test(normalizeUriForSchemeTest(attr.value))
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });

  // Add tracking-mitigation attributes to all <img> tags so external images load
  // without leaking the app origin as referrer and only when scrolled into view.
  doc.querySelectorAll("img").forEach((img) => {
    img.setAttribute("referrerpolicy", "no-referrer");
    if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
  });

  return doc.documentElement.outerHTML;
};

export const processHtmlToSendMail = (html: string) => {
  const div = window.document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("*").forEach((e) => {
    if (e instanceof HTMLElement) {
      e.style.fontWeight = "normal";
    }
  });
  div.querySelectorAll("p").forEach((e) => {
    if (!e.innerText.trim()) {
      const br = window.document.createElement("br");
      e.parentNode?.replaceChild(br, e);
    }
  });
  div.querySelectorAll("p, ul, ol").forEach((e) => {
    const htmlE = e as HTMLElement;
    htmlE.style.marginTop = "0.5rem";
    htmlE.style.marginBottom = "0.5rem";
  });
  div.querySelectorAll("blockquote").forEach((e) => {
    e.style.margin = "10px 0 10px 0";
    e.style.padding = "0 0 0 0.5rem";
    e.style.borderLeft = "5px solid #888";
  });
  div.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((e) => {
    const heading = e as HTMLHeadingElement;
    heading.style.fontWeight = "bolder";
  });
  div.querySelectorAll("code").forEach((e) => {
    e.style.backgroundColor = "#eee";
    e.style.color = "#c50";
    e.style.borderRadius = "2px";
    e.style.fontFamily = "monospace";
    e.style.padding = "0 5px";
  });
  div.querySelectorAll("pre").forEach((e) => {
    e.style.backgroundColor = "#444";
    e.style.color = "#fff";
    e.style.borderRadius = "3px";
    e.style.padding = "0.5rem";
  });
  div.querySelectorAll("pre > code").forEach((e) => {
    const htmlE = e as HTMLElement;
    htmlE.style.color = "inherit";
    htmlE.style.background = "none";
    htmlE.style.padding = "0";
  });
  return div.innerHTML;
};

export const processHtmlForViewer = (html: string) => {
  // Sanitize HTML as defense-in-depth before rendering in iframe.
  // The iframe has sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  // to block script execution while allowing links to open in new tabs normally.
  // This stripping adds an extra layer against script tags, event handlers,
  // and dangerous URI schemes.
  const sanitized = sanitizeEmailHtml(html);
  // Document-scoped Referer suppression, covering <img> plus every other
  // remote-resource vector (CSS, <link>, <input type=image>, <video poster>,
  // <table background>, and anything added later). Placed first so the HTML
  // parser lands it in the document <head>; mail-authored <meta
  // name="referrer"> is stripped by the sanitizer above so it cannot
  // override this (the last meta wins). The per-<img> referrerpolicy
  // attribute is now redundant but left in place (harmless).
  return `<meta name="referrer" content="no-referrer">
<style>
  body {
      margin: 0;
      overflow: hidden;
      width: 100%;
      height: 100%
  }
  * {
      font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI",
      "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans",
      "Helvetica Neue", sans-serif;
      color: rgb(70,70,70);
  }
</style>
${sanitized}
`;
};
