# CSS custom properties in `style`

`@gokayo43/dev-config/css-custom-properties` is a type declaration that makes
any `--name` a legal key of React's `CSSProperties`. A repo names it in its own
`tsconfig.json`, beside what it already lists:

```jsonc
{
  "compilerOptions": {
    "types": ["bun", "@gokayo43/dev-config/css-custom-properties"],
  },
}
```

It goes in `types` for the reason [the bun:test addition](bun-test.md) does: a
repo's own `types` replaces the base's, and an `include` entry into
`node_modules` is dropped by `exclude: ["node_modules"]`.

## Why

`shadcn/no-inline-styles` sends a value known only at runtime through a CSS
custom property, read by a class:

```tsx
<aside style={{ "--panel-width": `${width}px` }} className="w-(--panel-width)" />
```

React's `CSSProperties` declares no custom property, so without the declaration
that object is an excess property, and the spelling upstream documents,
`{ … } as React.CSSProperties`, is the assertion
`typescript/consistent-type-assertions` refuses. The declaration's key is the
template `` `--${string}` ``, so a misspelt property (`"-panel-width"`) and a
value no style takes (an object) are still type errors.
`tests/declarations.test.ts` grades all three.
