// React's `CSSProperties` declares no custom property, so a value known only at
// runtime (`style={{ "--panel-width": … }}`, read by `w-(--panel-width)`) would
// need the cast `typescript/consistent-type-assertions` refuses. A template key
// admits every `--name` and nothing else, so a misspelt property is still an
// excess property. The named type import is what makes this file a module, and
// the forms that would do the same without one each draw a lint rule.
import type { CSSProperties } from "react";

declare module "react" {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
