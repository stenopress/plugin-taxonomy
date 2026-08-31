import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { extractYaml } from "@std/front-matter";
import { join } from "@std/path";
import type { SiteConfig } from "@steno/steno";
import createPlugin, {
  buildTermIndex,
  slugifyTerm,
  type TaxonomyPageInput,
} from "./mod.ts";

async function write(root: string, relPath: string, content: string) {
  const full = join(root, relPath);
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, content);
}

async function readFrontmatter(path: string): Promise<Record<string, unknown>> {
  const text = await Deno.readTextFile(path);
  return extractYaml<Record<string, unknown>>(text).attrs;
}

function exists(path: string): Promise<boolean> {
  return Deno.stat(path).then(() => true).catch(() => false);
}

function siteConfig(
  contentDir: string,
  overrides: Partial<SiteConfig> = {},
): SiteConfig {
  return {
    title: "Test site",
    description: "",
    author: "",
    contentDir,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers: slugifyTerm / buildTermIndex
// ---------------------------------------------------------------------------

Deno.test("slugifyTerm: lowercases and hyphenates", () => {
  assertEquals(slugifyTerm("Web Development"), "web-development");
});

Deno.test("slugifyTerm: strips diacritics and punctuation", () => {
  assertEquals(slugifyTerm("Café/Life!"), "cafe-life");
});

Deno.test("slugifyTerm: falls back to 'term' when nothing survives", () => {
  assertEquals(slugifyTerm("🎉🎉🎉"), "term");
});

Deno.test("buildTermIndex: groups multi-term pages under each term", () => {
  const pages: TaxonomyPageInput[] = [
    { title: "A", url: "/a", terms: ["rust", "deno"] },
    { title: "B", url: "/b", terms: ["rust"] },
  ];
  const entries = buildTermIndex(pages);
  assertEquals(entries.map((e) => e.term), ["deno", "rust"]);
  assertEquals(
    entries.find((e) => e.term === "rust")?.pages.map((p) => p.title),
    ["A", "B"],
  );
  assertEquals(
    entries.find((e) => e.term === "deno")?.pages.map((p) => p.title),
    ["A"],
  );
});

Deno.test("buildTermIndex: a page with no terms contributes to nothing", () => {
  const pages: TaxonomyPageInput[] = [
    { title: "A", url: "/a", terms: [] },
    { title: "B", url: "/b", terms: ["tag"] },
  ];
  const entries = buildTermIndex(pages);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].term, "tag");
});

Deno.test("buildTermIndex: resolves slug collisions deterministically", () => {
  const pages: TaxonomyPageInput[] = [
    { title: "A", url: "/a", terms: ["C++"] },
    { title: "B", url: "/b", terms: ["C--"] },
  ];
  const entries = buildTermIndex(pages);
  // "C++" and "C--" both slugify to "c" — whichever term is processed first
  // (alphabetically) keeps the base slug; the other gets "-2" appended.
  const slugs = entries.map((e) => e.slug).sort();
  assertEquals(slugs, ["c", "c-2"]);
  assertEquals(new Set(entries.map((e) => e.slug)).size, entries.length);
});

Deno.test("buildTermIndex: preserves description and date per page", () => {
  const pages: TaxonomyPageInput[] = [
    {
      title: "A",
      url: "/a",
      terms: ["x"],
      description: "desc",
      date: "2026-01-01",
    },
  ];
  const entries = buildTermIndex(pages);
  assertEquals(entries[0].pages[0], {
    title: "A",
    url: "/a",
    description: "desc",
    date: "2026-01-01",
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

Deno.test("plugin-taxonomy: throws when taxonomies is missing or empty", () => {
  // deno-lint-ignore no-explicit-any
  assertThrows(() => createPlugin({} as any), Error, "non-empty");
  assertThrows(() => createPlugin({ taxonomies: [] }), Error, "non-empty");
});

Deno.test("plugin-taxonomy: throws on an invalid taxonomy name", () => {
  assertThrows(
    () => createPlugin({ taxonomies: [{ name: "tags/evil" }] }),
    Error,
    "invalid taxonomies[].name",
  );
});

Deno.test("plugin-taxonomy: has a stable name", () => {
  const plugin = createPlugin({ taxonomies: [{ name: "tags" }] });
  assertEquals(plugin.name, "plugin-taxonomy");
});

// ---------------------------------------------------------------------------
// beforeBuild: full generation
// ---------------------------------------------------------------------------

Deno.test("plugin-taxonomy: generates a listing page and one page per term", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(
      root,
      "posts/hello.md",
      "---\ntitle: Hello\ntags: [rust, deno]\n---\nBody",
    );
    await write(
      root,
      "posts/world.md",
      "---\ntitle: World\ntags: [rust]\n---\nBody",
    );
    await write(root, "posts/untagged.md", "---\ntitle: Untagged\n---\nBody");

    const plugin = createPlugin({ taxonomies: [{ name: "tags" }] });
    await plugin.beforeBuild?.(siteConfig(root));

    assertEquals(await exists(join(root, "tags", "index.md")), true);
    assertEquals(await exists(join(root, "tags", "rust.md")), true);
    assertEquals(await exists(join(root, "tags", "deno.md")), true);

    const listAttrs = await readFrontmatter(join(root, "tags", "index.md"));
    assertEquals(listAttrs.layout, "taxonomy-list");
    // deno-lint-ignore no-explicit-any
    const terms = (listAttrs.steno as any).globals.terms;
    assertEquals(terms.map((t: { name: string }) => t.name).sort(), [
      "deno",
      "rust",
    ]);

    const rustAttrs = await readFrontmatter(join(root, "tags", "rust.md"));
    assertEquals(rustAttrs.layout, "taxonomy-term");
    // deno-lint-ignore no-explicit-any
    const rustGlobals = (rustAttrs.steno as any).globals;
    assertEquals(rustGlobals.term.name, "rust");
    assertEquals(rustGlobals.term.count, 2);
    assertEquals(
      rustGlobals.items.map((p: { title: string }) => p.title).sort(),
      ["Hello", "World"],
    );

    const body = await Deno.readTextFile(join(root, "tags", "rust.md"));
    assertEquals(
      body.includes("<!-- generated by plugin-taxonomy, do not edit -->"),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: draft pages are excluded from the index", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(
      root,
      "posts/wip.md",
      "---\ntitle: WIP\ntags: [rust]\ndraft: true\n---\n",
    );

    const plugin = createPlugin({ taxonomies: [{ name: "tags" }] });
    await plugin.beforeBuild?.(siteConfig(root));

    assertEquals(await exists(join(root, "tags", "rust.md")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: custom field name is respected", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(root, "posts/a.md", "---\ntitle: A\nkind: [essay]\n---\n");

    const plugin = createPlugin({
      taxonomies: [{ name: "kinds", field: "kind" }],
    });
    await plugin.beforeBuild?.(siteConfig(root));

    assertEquals(await exists(join(root, "kinds", "essay.md")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: termMeta is merged into the term's globals and listing entry", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(root, "posts/a.md", "---\ntitle: A\ntags: [rust]\n---\n");

    const plugin = createPlugin({
      taxonomies: [{
        name: "tags",
        termMeta: { rust: { icon: "gear", color: "orange" } },
      }],
    });
    await plugin.beforeBuild?.(siteConfig(root));

    const rustAttrs = await readFrontmatter(join(root, "tags", "rust.md"));
    // deno-lint-ignore no-explicit-any
    const term = (rustAttrs.steno as any).globals.term;
    assertEquals(term.icon, "gear");
    assertEquals(term.color, "orange");

    const listAttrs = await readFrontmatter(join(root, "tags", "index.md"));
    // deno-lint-ignore no-explicit-any
    const terms = (listAttrs.steno as any).globals.terms;
    assertEquals(terms[0].icon, "gear");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: paginateBy splits a term's pages across multiple files", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (let i = 1; i <= 5; i++) {
      await write(
        root,
        `posts/p${i}.md`,
        `---\ntitle: Post ${i}\ntags: [rust]\n---\n`,
      );
    }

    const plugin = createPlugin({
      taxonomies: [{ name: "tags", paginateBy: 2 }],
    });
    await plugin.beforeBuild?.(siteConfig(root));

    assertEquals(await exists(join(root, "tags", "rust.md")), true);
    assertEquals(
      await exists(join(root, "tags", "rust", "page", "2.md")),
      true,
    );
    assertEquals(
      await exists(join(root, "tags", "rust", "page", "3.md")),
      true,
    );
    assertEquals(
      await exists(join(root, "tags", "rust", "page", "4.md")),
      false,
    );

    const page1 = await readFrontmatter(join(root, "tags", "rust.md"));
    // deno-lint-ignore no-explicit-any
    const g1 = (page1.steno as any).globals;
    assertEquals(g1.items.length, 2);
    assertEquals(g1.pagination, { page: 1, totalPages: 3, perPage: 2 });

    const page3 = await readFrontmatter(
      join(root, "tags", "rust", "page", "3.md"),
    );
    // deno-lint-ignore no-explicit-any
    const g3 = (page3.steno as any).globals;
    assertEquals(g3.items.length, 1);
    assertEquals(g3.pagination.page, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: regenerating prunes a term that disappeared", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(root, "posts/a.md", "---\ntitle: A\ntags: [rust, deno]\n---\n");

    const plugin = createPlugin({ taxonomies: [{ name: "tags" }] });
    await plugin.beforeBuild?.(siteConfig(root));
    assertEquals(await exists(join(root, "tags", "deno.md")), true);

    // "deno" tag disappears on the next rebuild (e.g. steno dev after an edit)
    await Deno.writeTextFile(
      join(root, "posts", "a.md"),
      "---\ntitle: A\ntags: [rust]\n---\n",
    );
    await plugin.beforeBuild?.(siteConfig(root));

    assertEquals(await exists(join(root, "tags", "deno.md")), false);
    assertEquals(await exists(join(root, "tags", "rust.md")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: running beforeBuild twice with identical content is stable", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(root, "posts/a.md", "---\ntitle: A\ntags: [rust]\n---\n");

    const plugin = createPlugin({ taxonomies: [{ name: "tags" }] });
    await plugin.beforeBuild?.(siteConfig(root));
    await plugin.beforeBuild?.(siteConfig(root));

    assertEquals(await exists(join(root, "tags", "rust.md")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: refuses to overwrite a real pre-existing contentDir/tags/", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(
      root,
      "tags/index.md",
      "---\ntitle: My real tags page\n---\nHand-written content.",
    );
    await write(root, "posts/a.md", "---\ntitle: A\ntags: [rust]\n---\n");

    const plugin = createPlugin({ taxonomies: [{ name: "tags" }] });
    await assertRejects(
      () => plugin.beforeBuild?.(siteConfig(root)) as Promise<void>,
      Error,
      "refusing to overwrite",
    );

    // the real user content must survive untouched
    const text = await Deno.readTextFile(join(root, "tags", "index.md"));
    assertEquals(text.includes("Hand-written content."), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: two taxonomies (tags + categories) don't index each other's output", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(
      root,
      "posts/a.md",
      "---\ntitle: A\ntags: [rust]\ncategories: [dev]\n---\n",
    );

    const plugin = createPlugin({
      taxonomies: [{ name: "tags" }, { name: "categories" }],
    });
    await plugin.beforeBuild?.(siteConfig(root));

    assertEquals(await exists(join(root, "tags", "rust.md")), true);
    assertEquals(await exists(join(root, "categories", "dev.md")), true);

    // categories/ generated pages must not have been picked up as "tags" content
    const tagsList = await readFrontmatter(join(root, "tags", "index.md"));
    // deno-lint-ignore no-explicit-any
    const tagsTerms = (tagsList.steno as any).globals.terms;
    assertEquals(tagsTerms.map((t: { name: string }) => t.name), ["rust"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plugin-taxonomy: title falls back to a humanized filename", async () => {
  const root = await Deno.makeTempDir();
  try {
    await write(root, "posts/no-title.md", "---\ntags: [rust]\n---\n");

    const plugin = createPlugin({ taxonomies: [{ name: "tags" }] });
    await plugin.beforeBuild?.(siteConfig(root));

    const rustAttrs = await readFrontmatter(join(root, "tags", "rust.md"));
    // deno-lint-ignore no-explicit-any
    const items = (rustAttrs.steno as any).globals.items;
    assertEquals(items[0].title, "No Title");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
