import { createReadStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { marked } from "marked";
import { getInterfacePhrases } from "@logto/phrases-experience/lib/interface.js";

import {
  applyTranslationCache,
  assertPublishedContentIsSafe,
  escapeHtml,
  isPublishableDocument,
  paths,
  readLocales,
  readSource,
  readVisibilityPolicy,
  routeFromRelativePath,
  sha256,
  transformMdx,
} from "./lib.mjs";

const readFilesRecursively = async (root) => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return readFilesRecursively(absolutePath);
      }
      return [absolutePath];
    }),
  );

  return nested.flat();
};

const hashFile = async (file) => {
  const chunks = [];
  for await (const chunk of createReadStream(file)) {
    chunks.push(chunk);
  }
  return sha256(Buffer.concat(chunks));
};

const source = await readSource();
const locales = await readLocales();
const policy = await readVisibilityPolicy();
const actualArchiveHash = await hashFile(paths.archive);

if (actualArchiveHash !== source.archiveSha256) {
  throw new Error(
    `Documentation archive checksum mismatch: expected ${source.archiveSha256}, received ${actualArchiveHash}`,
  );
}

const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "iden-help-center-"),
);
const extractDirectory = path.join(temporaryDirectory, "source");
await mkdir(extractDirectory, { recursive: true });

const extractResult = spawnSync(
  "tar",
  ["-xzf", paths.archive, "-C", extractDirectory],
  {
    stdio: "inherit",
  },
);
if (extractResult.status !== 0) {
  throw new Error("Unable to extract the pinned documentation source archive.");
}

const extractedEntries = await readdir(extractDirectory, {
  withFileTypes: true,
});
const sourceRootEntry = extractedEntries.find((entry) => entry.isDirectory());
if (!sourceRootEntry?.name.endsWith(source.commit)) {
  throw new Error(
    "The documentation archive root does not match the pinned commit.",
  );
}

const upstreamRoot = path.join(extractDirectory, sourceRootEntry.name);
const englishRoot = path.join(upstreamRoot, "docs");
const allEnglishFiles = await readFilesRecursively(englishRoot);
const englishDocuments = allEnglishFiles
  .map((file) => path.relative(englishRoot, file).replaceAll(path.sep, "/"))
  .filter((relativePath) => isPublishableDocument(relativePath, policy))
  .sort((left, right) => left.localeCompare(right));

await rm(paths.dist, { recursive: true, force: true });
await mkdir(paths.dist, { recursive: true });

const assetsRoot = path.join(paths.dist, "assets/upstream");
for (const file of allEnglishFiles) {
  if (/\.(?:md|mdx)$/i.test(file)) {
    continue;
  }
  const relativePath = path.relative(englishRoot, file);
  const target = path.join(assetsRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(file, target);
}

const staticRoot = path.join(upstreamRoot, "static");
try {
  await access(staticRoot);
  const staticFiles = await readFilesRecursively(staticRoot);
  for (const file of staticFiles) {
    if (/\.(?:md|mdx|txt)$/i.test(file)) {
      continue;
    }
    const relativePath = path.relative(staticRoot, file);
    const target = path.join(assetsRoot, "static", relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(file, target);
  }
} catch {
  // The upstream static directory is optional; document-local assets are already copied above.
}

const availableUpstreamLocales = new Map(
  await Promise.all(
    locales.map(async (locale) => {
      if (locale === "en") {
        return [locale, englishRoot];
      }
      const root = path.join(
        upstreamRoot,
        "i18n",
        locale,
        "docusaurus-plugin-content-docs/current",
      );
      try {
        await access(root);
        return [locale, root];
      } catch {
        return [locale, englishRoot];
      }
    }),
  ),
);

const primaryNavigation = [
  ["introduction", "introduction"],
  ["quick-starts", "quick_starts"],
  ["integrate-iden", "integration"],
  ["end-user-flows", "end_user_flows"],
  ["authorization", "authorization"],
  ["user-management", "user_management"],
  ["security", "security"],
  ["customization", "customization"],
  ["connectors", "connectors"],
  ["organizations", "organizations"],
  ["iden-oss", "self_hosting"],
];

const idenMark = await readFile(
  path.join(paths.packageRoot, "../toolkit/core-kit/assets/iden-mark.svg"),
  "utf8",
);
const inlineIdenMark = idenMark.replace(
  "<svg ",
  '<svg aria-hidden="true" class="brand-mark" ',
);

const globalStyles = `
:root{color-scheme:light dark;--brand:#5b5cf6;--brand-strong:#4b4ce1;--bg:#fff;--surface:#fafafa;--text:#17181c;--muted:#686b75;--line:#e8e9ee;--code:#f5f5f7}
@media(prefers-color-scheme:dark){:root{--brand:#8b8cff;--brand-strong:#a3a4ff;--bg:#17181c;--surface:#1f2025;--text:#f4f4f6;--muted:#a6a8b0;--line:#34353d;--code:#24252b}}
*{box-sizing:border-box}html{background:var(--bg);color:var(--text);font:15px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0}a{color:var(--brand-strong);text-decoration:none}a:hover{text-decoration:underline}.shell{min-height:100vh;display:grid;grid-template-columns:240px minmax(0,1fr)}.sidebar{position:sticky;top:0;height:100vh;padding:24px 18px;border-right:1px solid var(--line);background:var(--bg);overflow:auto}.brand{display:flex;align-items:center;gap:10px;margin:0 8px 28px;color:var(--brand);font-size:24px;font-weight:700;letter-spacing:-.04em}.brand-mark,.brand-custom-logo{width:30px;height:30px;object-fit:contain}.brand-custom-logo{display:none}.brand span{color:var(--text)}.search{width:100%;height:38px;padding:0 12px;margin-bottom:18px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);outline:none}.search:focus{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 14%,transparent)}.search-results{display:none;margin:-8px 0 16px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font-size:13px}.search-results.active{display:block}.search-results a{display:block;padding:6px 4px;color:var(--text)}nav a{display:block;padding:8px 10px;border-radius:6px;color:var(--muted);font-size:14px}nav a[aria-current=page],nav a:hover{background:color-mix(in srgb,var(--brand) 8%,transparent);color:var(--text);text-decoration:none}.about-link{margin-top:18px;padding-top:18px;border-top:1px solid var(--line)}.content{width:min(920px,100%);padding:64px clamp(28px,6vw,88px) 96px}.compatibility{margin-bottom:36px;padding:12px 16px;border-left:2px solid var(--brand);background:var(--surface);color:var(--muted);font-size:13px}article h1{margin:0 0 24px;font-size:38px;line-height:1.2;letter-spacing:-.035em}article h2{margin:52px 0 14px;padding-bottom:10px;border-bottom:1px solid var(--line);font-size:24px;line-height:1.3;letter-spacing:-.02em}article h3{margin:32px 0 10px;font-size:18px}article p,article li{max-width:760px}article img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:10px}pre{overflow:auto;padding:18px;border:1px solid var(--line);border-radius:10px;background:var(--code);font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}code{padding:2px 5px;border-radius:4px;background:var(--code);font:13px ui-monospace,SFMono-Regular,Menlo,monospace}pre code{padding:0;background:transparent}blockquote{margin:20px 0;padding:4px 18px;border-left:2px solid var(--line);color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid var(--line);text-align:left}.source-note{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.menu-button{display:none}
body.embedded .sidebar{display:none}body.embedded .shell{display:block}body.embedded .content{width:100%;padding:28px 32px 56px}body.embedded article h1{font-size:30px}
@media(max-width:760px){.shell{display:block}.sidebar{position:fixed;z-index:10;inset:0 20% 0 0;transform:translateX(-105%);transition:transform .18s ease;box-shadow:12px 0 36px rgb(0 0 0/.12)}body.menu-open .sidebar{transform:none}.menu-button{display:block;position:fixed;z-index:9;right:16px;bottom:16px;height:42px;padding:0 16px;border:0;border-radius:8px;background:var(--brand);color:white;font:600 14px/1 Inter,ui-sans-serif,system-ui}.content{padding:42px 22px 72px}article h1{font-size:32px}}
`;

const renderNavigation = (locale, currentRoute) =>
  primaryNavigation
    .map(([route, label]) => {
      const isCurrent =
        currentRoute === route || currentRoute.startsWith(`${route}/`);
      return `<a href="/help/${locale}/${route}/"${isCurrent ? ' aria-current="page"' : ""}>${escapeHtml(getInterfacePhrases(locale)[label])}</a>`;
    })
    .join("");

const renderLocaleOptions = (currentLocale, route) =>
  locales
    .map(
      (locale) =>
        `<option value="/help/${locale}/${route}/"${locale === currentLocale ? " selected" : ""}>${locale}</option>`,
    )
    .join("");

const renderPage = ({
  locale,
  route,
  title,
  description,
  content,
  sourcePath,
  sourceHash,
}) => {
  const safeTitle = escapeHtml(title);
  const ui = getInterfacePhrases(locale);
  const t = (key) => escapeHtml(ui[key]);
  const page = `<!doctype html>
<html lang="${escapeHtml(locale)}" dir="${["ar", "fa-IR"].includes(locale) ? "rtl" : "ltr"}" data-product-brand="iden"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#5B5CF6"><meta name="description" content="${escapeHtml(description)}"><title>${safeTitle} · ${t("help_title")}</title><style>${globalStyles}</style></head>
<body><button class="menu-button" type="button" aria-label="${t("open_navigation")}">${t("menu")}</button><div class="shell"><aside class="sidebar"><a class="brand" href="/help/${locale}/">${inlineIdenMark}<img alt="" class="brand-custom-logo"><span data-platform-brand-name>iden</span></a><input class="search" type="search" placeholder="${t("search_help")}" aria-label="${t("search_help")}"><div class="search-results"></div><select class="search" aria-label="${t("language")}" onchange="location.href=this.value">${renderLocaleOptions(locale, route)}</select><nav>${renderNavigation(locale, route)}<a data-open-source-notice class="about-link" href="/help/${locale}/about/">${t("about")}</a></nav></aside><main class="content"><div class="compatibility">${t("compatibility_notice")}</div><article data-pagefind-body><h1 data-pagefind-meta="title">${safeTitle}</h1>${content}</article><footer data-open-source-notice class="source-note">${t("source")}: logto-io/docs@${source.commit.slice(0, 12)} · ${escapeHtml(sourcePath)} · ${sourceHash.slice(0, 12)}</footer></main></div>
<script type="module">const params=new URLSearchParams(location.search);if(params.get('embedded')==='1')document.body.classList.add('embedded');document.querySelector('.menu-button')?.addEventListener('click',()=>document.body.classList.toggle('menu-open'));try{const response=await fetch('/api/platform-branding',{credentials:'same-origin'});if(response.ok){const brand=await response.json();document.querySelectorAll('[data-platform-brand-name]').forEach(node=>node.textContent=brand.productName);document.querySelectorAll('[data-platform-brand-slogan]').forEach(node=>node.textContent=brand.slogan);if(brand.hideOpenSourceNotice)document.querySelectorAll('[data-open-source-notice]').forEach(node=>node.remove());const logo=document.querySelector('.brand-custom-logo');const mark=document.querySelector('.brand-mark');const applyLogo=()=>{const dark=matchMedia('(prefers-color-scheme:dark)').matches;const url=dark?(brand.darkLogoUrl||brand.logoUrl):(brand.logoUrl||brand.darkLogoUrl);if(url){logo.src=url;logo.style.display='block';mark.style.display='none'}else{logo.removeAttribute('src');logo.style.display='none';mark.style.display='block'}};applyLogo();matchMedia('(prefers-color-scheme:dark)').addEventListener('change',applyLogo);const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;if(!node.parentElement?.closest('code,pre,script,style'))node.textContent=node.textContent?.replace(/\biden\b/gi,()=>brand.productName)??''}document.title=document.title.replace(/iden/gi,()=>brand.productName)}}catch{}const input=document.querySelector('.search[type=search]');const results=document.querySelector('.search-results');let pagefind;input?.addEventListener('input',async()=>{const query=input.value.trim();if(query.length<2){results.classList.remove('active');results.innerHTML='';return}pagefind??=await import('/help/pagefind/pagefind.js');const response=await pagefind.search(query);const items=await Promise.all(response.results.slice(0,8).map(item=>item.data()));results.innerHTML=items.map(item=>'<a href="'+item.url+'">'+item.meta.title+'</a>').join('');results.classList.toggle('active',items.length>0)});</script></body></html>`;
  assertPublishedContentIsSafe(page, policy, `${locale}/${route}`);
  return page;
};

const writePage = async (locale, route, html) => {
  const directory = path.join(paths.dist, locale, route);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.html"), html);
};

const buildLocale = async (locale, localeRoot) => {
  const ui = getInterfacePhrases(locale);
  const t = (key) => escapeHtml(ui[key]);
  let translationCache;
  try {
    translationCache = JSON.parse(
      await readFile(path.join(paths.translations, `${locale}.json`), "utf8"),
    );
  } catch {
    // Upstream translations and English fallback remain authoritative when no local cache exists.
  }
  let count = 0;
  for (const relativePath of englishDocuments) {
    const localizedPath = path.join(localeRoot, relativePath);
    let selectedPath = localizedPath;
    try {
      await access(localizedPath);
    } catch {
      selectedPath = path.join(englishRoot, relativePath);
    }

    const contentSource = applyTranslationCache(
      await readFile(selectedPath, "utf8"),
      translationCache,
    );
    const transformed = transformMdx(
      contentSource,
      relativePath,
      locale,
      policy,
    );
    const rendered = marked.parse(transformed.markdown, {
      gfm: true,
      breaks: false,
    });
    const route = routeFromRelativePath(relativePath);
    await writePage(
      locale,
      route,
      renderPage({
        locale,
        route,
        title: transformed.title,
        description: transformed.description,
        content: rendered,
        sourcePath: relativePath,
        sourceHash: transformed.sourceHash,
      }),
    );
    count += 1;
  }

  const aboutContent = `<p><strong data-platform-brand-name>iden</strong> — <span data-platform-brand-slogan>Identity, Unified.</span></p><div data-open-source-notice><p>${t("license_notice")}</p><ul><li><a href="https://www.mozilla.org/MPL/2.0/">Mozilla Public License 2.0</a></li><li><a href="https://github.com/logto-io/logto">${t("upstream_repository")}</a></li><li><a href="https://github.com/ryan-iden/iden">${t("current_fork")}</a></li></ul></div><p>${t("compatibility_notice")}</p>`;
  await writePage(
    locale,
    "about",
    renderPage({
      locale,
      route: "about",
      title: ui.about,
      description: ui.about_description,
      content: aboutContent,
      sourcePath: "local/about",
      sourceHash: sha256(aboutContent),
    }),
  );

  await writeFile(
    path.join(paths.dist, locale, "index.html"),
    `<!doctype html><html lang="${escapeHtml(locale)}"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/help/${locale}/introduction/"><title>${t("help_title")}</title><a href="/help/${locale}/introduction/">${t("open_help")}</a></html>`,
  );

  await writePage(
    locale,
    "404",
    renderPage({
      locale,
      route: "404",
      title: ui.page_not_found,
      description: ui.page_not_found_description,
      content:
        "<p>" +
        t("page_not_found_description") +
        '</p><a href="/help/' +
        locale +
        '/">' +
        t("help_title") +
        "</a>",
      sourcePath: "local/404",
      sourceHash: sha256(ui.page_not_found),
    }),
  );
  return count + 2;
};

const localeCounts = {};
for (const [locale, localeRoot] of availableUpstreamLocales) {
  localeCounts[locale] = await buildLocale(locale, localeRoot);
}

const redirectsSource = await readFile(
  path.join(upstreamRoot, "static/_redirects-docs"),
  "utf8",
);
const redirects = redirectsSource
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .filter(
    ([from, to]) =>
      from?.startsWith("/") &&
      to?.startsWith("/") &&
      !from.includes("*") &&
      !to.includes("*") &&
      isPublishableDocument(`${from.replace(/^\/+/, "")}.mdx`, policy) &&
      isPublishableDocument(
        `${to.split("#", 1)[0].replace(/^\/+/, "")}.mdx`,
        policy,
      ),
  );

for (const locale of availableUpstreamLocales.keys()) {
  for (const [from, to] of redirects) {
    const fromRoute = routeFromRelativePath(from.replace(/^\/+|\/$/g, ""));
    const [targetPath, hash = ""] = to.split("#", 2);
    const targetRoute = routeFromRelativePath(
      targetPath.replace(/^\/+|\/$/g, ""),
    );
    const target = `/help/${locale}/${targetRoute}/${hash ? `#${hash}` : ""}`;
    const directory = path.join(paths.dist, locale, fromRoute);
    try {
      await access(path.join(directory, "index.html"));
      continue;
    } catch {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(
      path.join(directory, "index.html"),
      `<!doctype html><html lang="${escapeHtml(locale)}"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(target)}"><title>${escapeHtml(getInterfacePhrases(locale).help_title)}</title><a href="${escapeHtml(target)}">${escapeHtml(getInterfacePhrases(locale).continue)}</a></html>`,
    );
  }
}

let repairedLocalLinks = 0;
for (const locale of availableUpstreamLocales.keys()) {
  const localeRoot = path.join(paths.dist, locale);
  const htmlFiles = (await readFilesRecursively(localeRoot)).filter((file) =>
    file.endsWith(".html"),
  );
  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    let changed = false;
    const repaired = await Promise.all(
      [
        ...html.matchAll(/href="(\/help\/([^/]+)\/([^"?#]*)(?:[?#][^"]*)?)"/g),
      ].map(async ([fullMatch, href, targetLocale, targetRoute]) => {
        const target = path.join(
          paths.dist,
          targetLocale,
          targetRoute || "introduction",
          "index.html",
        );
        try {
          await access(target);
          return [fullMatch, fullMatch];
        } catch {
          changed = true;
          repairedLocalLinks += 1;
          return [fullMatch, `href="/help/${locale}/introduction/"`];
        }
      }),
    );
    if (changed) {
      const replacements = new Map(repaired);
      await writeFile(
        file,
        html.replaceAll(
          /href="\/help\/[^" ]+"/g,
          (match) => replacements.get(match) ?? match,
        ),
      );
    }
  }
}

const notFound = renderPage({
  locale: "en",
  route: "404",
  title: "Page not found",
  description: "The requested help page could not be found.",
  content:
    '<p>Return to the <a href="/help/en/">help center home</a> or use search.</p>',
  sourcePath: "local/404",
  sourceHash: sha256("Page not found"),
});
await writeFile(path.join(paths.dist, "404.html"), notFound);
await writeFile(
  path.join(paths.dist, "index.html"),
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/help/en/"><title>iden Help</title><a href="/help/en/">Open iden Help</a></html>',
);

const pagefindResult = spawnSync(
  process.platform === "win32" ? "pagefind.cmd" : "pagefind",
  ["--site", paths.dist, "--output-subdir", "pagefind", "--glob", "**/*.html"],
  { cwd: paths.packageRoot, stdio: "inherit" },
);
if (pagefindResult.status !== 0) {
  throw new Error("Pagefind indexing failed.");
}

await writeFile(
  path.join(paths.dist, "source-attribution.json"),
  `${JSON.stringify(
    {
      ...source,
      archiveSha256: actualArchiveHash,
      visibilityPolicyVersion: policy.version,
      locales,
      localeCounts,
      englishDocumentCount: englishDocuments.length,
      repairedLocalLinks,
    },
    undefined,
    2,
  )}\n`,
);

await rm(temporaryDirectory, { recursive: true, force: true });
console.log(
  `Built iden Help from ${englishDocuments.length} source documents for ${locales.length} locales.`,
);
