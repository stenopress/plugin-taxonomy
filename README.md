# @steno/plugin-taxonomy

Taxonomy plugin for [Steno](https://github.com/steno/steno) that adds Zola-style taxonomies (tags,
categories, or any other frontmatter-driven classification): auto-generated term listing pages,
per-term single pages, and per-term pagination.

This is for a site that wants `/tags/` and `/tags/<term>/` pages generated automatically from a
repeated frontmatter field. Steno's own `collections` only sort/filter/limit _one_ content folder -
it has no concept of grouping pages across a collection by a repeated field and generating a page per
distinct value. This plugin fills that gap.

## Installation

```yaml
# content/.steno/config.yml
plugins:
  - jsr:@steno/plugin-taxonomy
```

## Options

```yaml
plugins:
  - package: jsr:@steno/plugin-taxonomy
    options:
      taxonomies:
        - name: tags
          feed: true
          paginateBy: 10
        - name: categories
          feed: true
          termMeta:
            dev: { icon: "code", color: "blue", description: "Development posts" }
```

| Option                    | Type                                                   | Default                                                                   | Description                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taxonomies`              | `TaxonomyConfig[]`                                     | - (required, non-empty - the factory throws immediately if empty/missing) | One entry per taxonomy.                                                                                                                                                                              |
| `taxonomies[].name`       | `string`                                               | -                                                                         | Route prefix and generated folder name (`contentDir/<name>/`). Must match `^[a-zA-Z0-9_-]+$` - an invalid name throws when the plugin is constructed.                                                |
| `taxonomies[].field`      | `string`                                               | same as `name`                                                            | Frontmatter field read from each page. Accepts a single string value or an array of strings.                                                                                                         |
| `taxonomies[].feed`       | `boolean`                                              | `false`                                                                   | Stamps `steno.globals.term.feed` on generated term pages. Does not generate feed XML - see "Feeds" below.                                                                                            |
| `taxonomies[].paginateBy` | `number \| undefined`                                  | `undefined` (no pagination)                                               | Splits a term's page listing into pages of this size - see "Pagination" below.                                                                                                                       |
| `taxonomies[].termMeta`   | `Record<string, Record<string, unknown>> \| undefined` | `undefined`                                                               | Static per-term metadata (icon, color, description), keyed by the exact term string. Merged into both the term's own `steno.globals.term` and its entry in the listing page's `steno.globals.terms`. |
| `taxonomies[].layout`     | `string`                                               | `"taxonomy-term"`                                                         | Layout name for a single term page.                                                                                                                                                                  |
| `taxonomies[].listLayout` | `string`                                               | `"taxonomy-list"`                                                         | Layout name for the taxonomy's listing page.                                                                                                                                                         |
| `contentDir`              | `string \| undefined`                                  | `config.contentDir` (`"content"`)                                         | Content root to scan and write into.                                                                                                                                                                 |

Draft pages (`draft: true`) are excluded from every taxonomy index.

## How it works

Steno's `StenoPlugin` contract has exactly five hooks: `beforeBuild`, `transformAst`,
`transformHtml`, `afterPage`, `afterBuild` (see
[types.ts](https://github.com/stenopress/steno/blob/main/src/types.ts) and
[plugins.md](https://github.com/stenopress/steno/blob/main/docs/plugins.md)). None of them lets a
plugin register a brand-new route directly into Steno's own rendering pipeline - `afterPage` and
`afterBuild` only ever see pages Steno already rendered from real content files.

The blessed way around that, the same technique `@steno/plugin-docs` uses, is to write real Markdown
files into `contentDir` before Steno's own content discovery runs. So this plugin's entire
implementation lives in `beforeBuild`:

1. Scans every real `.md` file under `contentDir` (skipping this plugin's own previously-generated
   output) and reads each page's configured taxonomy field, plus its title, description, and date.
2. Builds a term → pages index per configured taxonomy (`buildTermIndex`, exported and directly
   unit-testable - no filesystem involved).
3. Writes synthetic Markdown files into `contentDir/<name>/`:
   - `contentDir/<name>/index.md` - the taxonomy's listing page (`layout: taxonomy-list` by default),
     with every term's name, slug, url, and page count in `steno.globals.terms`.
   - `contentDir/<name>/<term-slug>.md` - one per term (`layout: taxonomy-term` by default), with the
     matching pages' basic info in `steno.globals.items` - see
     [content.md's "Per-page configuration"](https://github.com/stenopress/steno/blob/main/docs/content.md#per-page-configuration)
     for how `steno.globals` reaches a layout.

   Every generated file starts with an `<!-- generated by plugin-taxonomy, do not edit -->` marker in
   its body, and a sibling dotfile, `contentDir/<name>/.plugin-taxonomy-generated`, marks the whole
   folder as plugin-owned. Steno then discovers these files completely normally - through your theme,
   with layouts, everything - exactly like any hand-written page.

4. **Collision safety**: before writing anything into `contentDir/<name>/`, the plugin checks for
   that marker file. If the folder already exists _without_ it - meaning it's a real, hand-authored
   `contentDir/tags/` a user happens to already have - the plugin throws instead of silently
   overwriting it.
5. **Idempotent regeneration**: `beforeBuild` runs on every `steno dev` rebuild too, so once the
   marker check passes, the plugin deletes the entire generated folder and rewrites it from scratch
   on every run - simpler than diffing old vs. new terms, and it means a term that disappears between
   rebuilds never leaves a stale page behind.

### Feeds - not implemented, and why

An earlier draft of this plugin's spec promised `/tags/<term>/feed.xml` per term, "handing off to
whatever feed-serialization the site's `@steno/plugin-seo` already uses." Having now actually looked
at what's available: that hand-off doesn't exist. `@steno/plugin-seo`'s documented surface is one
sitewide `feed.xml`/`atom.xml` built from all pages - there is no documented per-collection or
per-term feed hook, and `StenoPlugin` has no cross-plugin API for one plugin to contribute additional
feed entries to another plugin's `afterBuild` output.

So `feed` is kept as an option for config-shape compatibility, but it does not generate any XML.
Setting it to `true` only stamps `steno.globals.term.feed = true` on that term's generated page, so a
theme's layout can render a link, a badge, or its own client-side feed affordance if it wants to.

### Pagination

`paginateBy` splits a term's page list across multiple generated files instead of one:

```text
contentDir/tags/rust.md            page 1 - steno.globals.items (first N pages), pagination.page = 1
contentDir/tags/rust/page/2.md     page 2 - pagination.page = 2, pagination.totalPages = ...
contentDir/tags/rust/page/3.md     page 3
```

Each file's `steno.globals.pagination` is `{ page, totalPages, perPage }`. The plugin doesn't compute
`nextUrl`/`prevUrl` itself - it can't know whether the site uses `shortUrls`, so a layout builds
those links from `pagination.page` and the term's own url.

### What a layout sees

Given `taxonomies: [{ name: "tags" }]`, `contentDir/tags/index.md` carries:

```yaml
steno:
  globals:
    taxonomy: tags
    terms:
      - { name: "rust", slug: "rust", url: "/tags/rust/", count: 3 }
      - { name: "deno", slug: "deno", url: "/tags/deno/", count: 1 }
```

and `contentDir/tags/rust.md` carries:

```yaml
steno:
  globals:
    taxonomy: tags
    term: { name: "rust", slug: "rust", count: 3, feed: false }
    items:
      - { title: "Hello", url: "/posts/hello", description: "...", date: "2026-01-01" }
      - { title: "World", url: "/posts/world" }
    pagination: { page: 1, totalPages: 1, perPage: 3 }
```

so a Tau layout can render either directly:

```html
{#each terms as term}
<a href="{term.url}">{term.name} <span class="counter">{term.count}</span></a>
{/each}
```

## Test

```sh
deno task test
```

## Learn more

- [Steno plugin development guide](https://github.com/stenopress/steno/blob/main/docs/plugins.md) - the `beforeBuild`/`@steno/plugin-docs` pattern this plugin is modeled on
- [Steno content & collections](https://github.com/stenopress/steno/blob/main/docs/content.md) - routing rules, `steno.globals` per-page overrides, and why collections alone aren't enough here
- [Zola taxonomies documentation](https://www.getzola.org/documentation/content/taxonomies/) - the feature this plugin's config shape is modeled on

## License

MIT
