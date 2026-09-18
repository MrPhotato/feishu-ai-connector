# Third-party notices

The original Feishu AI Connector code is distributed under the [MIT License](LICENSE). Third-party software remains under its own copyright and license terms; this project's license does not replace them.

## Source and assets carried by this project

| Component | Attribution and license | Preserved text |
| --- | --- | --- |
| Official lark-cli 1.0.95, including the pinned release archive and executable used by the build | Copyright (c) 2026 Lark Technologies Pte. Ltd.; MIT | [LICENSE](third_party/licenses/lark-cli-1.0.95/LICENSE); also retain native/THIRD_PARTY_NOTICES.md when distributing the native component |
| shadcn/ui-derived components in client/src/components/ui | Copyright (c) 2023 shadcn; MIT. Components have been adapted for this application and its template. | [LICENSE](third_party/licenses/shadcn-ui/LICENSE.md) |
| Lucide icons used through lucide-react | Lucide Contributors 2026; portions derived from Feather, copyright Cole Bemis 2013–2026. ISC plus MIT for the Feather-derived portions. | [Full dual notice](third_party/licenses/npm/lucide-react-0.577.0/LICENSE) |

Official sources: [lark-cli v1.0.95](https://github.com/larksuite/cli/blob/v1.0.95/LICENSE), [shadcn/ui](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md), [Lucide 0.577.0](https://github.com/lucide-icons/lucide/blob/0.577.0/LICENSE).

## Miaoda SDK and template attribution

The application uses the Miaoda fullstack template and these Lark SDK/preset packages: @lark-apaas/fullstack-nestjs-core, @lark-apaas/client-toolkit, @lark-apaas/coding-preset-vite-react, and @lark-apaas/fullstack-presets. Their published packages include a license titled “MIT License”, copyright (c) 2024 Lark Technologies Pte. Ltd. and/or its affiliates. The supplied text permits use, copying, modification, and distribution while requiring the copyright and permission notice to remain. The exact package texts are preserved below without rewriting their wording.

The client-toolkit package omits a package.json license field but supplies a LICENSE file. The corresponding table entry describes that file, rather than inferring an absent license. SDK licenses do not grant rights to Lark or Miaoda trademarks and do not replace hosted-service terms.

## Direct dependency license inventory

This inventory records the installed direct dependencies matching package-lock.json at the time of the initial public release. Frontend libraries may be declared as development dependencies while still contributing to a built frontend. License/NOTICE files are copied verbatim from the published packages; where a package omitted its file, the table names the official upstream source used for the copy. This inventory is not a complete transitive-dependency or native-binary bill of materials.

| Package | Version | Declared license | Use | Preserved text | Text source |
| --- | --- | --- | --- | --- | --- |
| `@lark-apaas/fullstack-nestjs-core` | 1.1.61 | MIT | Runtime | [LICENSE](third_party/licenses/npm/lark-apaas--fullstack-nestjs-core-1.1.61/LICENSE) | Published npm package |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT | Runtime | [LICENSE](third_party/licenses/npm/modelcontextprotocol--sdk-1.30.0/LICENSE) | Published npm package |
| `@nestjs/axios` | 4.0.1 | MIT | Runtime | [LICENSE](third_party/licenses/npm/nestjs--axios-4.0.1/LICENSE) | Published npm package |
| `@nestjs/cache-manager` | 3.1.3 | MIT | Runtime | [LICENSE](third_party/licenses/npm/nestjs--cache-manager-3.1.3/LICENSE) | Published npm package |
| `@nestjs/common` | 10.4.22 | MIT | Runtime | [LICENSE](third_party/licenses/npm/nestjs--common-10.4.22/LICENSE) | Published npm package |
| `@nestjs/config` | 3.3.0 | MIT | Runtime | [LICENSE](third_party/licenses/npm/nestjs--config-3.3.0/LICENSE) | Published npm package |
| `@nestjs/core` | 10.4.22 | MIT | Runtime | [LICENSE](third_party/licenses/npm/nestjs--core-10.4.22/LICENSE) | Published npm package |
| `@nestjs/platform-express` | 10.4.22 | MIT | Runtime | [LICENSE](third_party/licenses/npm/nestjs--platform-express-10.4.22/LICENSE) | Published npm package |
| `@nestjs/swagger` | 7.4.2 | MIT | Runtime | [LICENSE](third_party/licenses/npm/nestjs--swagger-7.4.2/LICENSE) | Published npm package |
| `@tanstack/react-form` | 1.33.5 | MIT | Runtime | [LICENSE](third_party/licenses/npm/tanstack--react-form-1.33.5/LICENSE) | Published npm package |
| `@tanstack/react-query` | 5.102.8 | MIT | Runtime | [LICENSE](third_party/licenses/npm/tanstack--react-query-5.102.8/LICENSE) | Published npm package |
| `ajv` | 8.12.0 | MIT | Runtime | [LICENSE](third_party/licenses/npm/ajv-8.12.0/LICENSE) | Published npm package |
| `axios` | 1.20.0 | MIT | Runtime | [LICENSE](third_party/licenses/npm/axios-1.20.0/LICENSE) | Published npm package |
| `cache-manager` | 6.4.3 | MIT | Runtime | [LICENSE](third_party/licenses/npm/cache-manager-6.4.3/LICENSE) | Published npm package |
| `class-transformer` | 0.5.1 | MIT | Runtime | [LICENSE](third_party/licenses/npm/class-transformer-0.5.1/LICENSE) | Published npm package |
| `class-validator` | 0.14.4 | MIT | Runtime | [LICENSE](third_party/licenses/npm/class-validator-0.14.4/LICENSE) | Published npm package |
| `crypto-js` | 4.2.0 | MIT | Runtime | [LICENSE](third_party/licenses/npm/crypto-js-4.2.0/LICENSE) | Published npm package |
| `dayjs` | 1.11.23 | MIT | Runtime | [LICENSE](third_party/licenses/npm/dayjs-1.11.23/LICENSE) | Published npm package |
| `dotenv` | 17.4.2 | BSD-2-Clause | Runtime | [LICENSE](third_party/licenses/npm/dotenv-17.4.2/LICENSE) | Published npm package |
| `drizzle-orm` | 0.44.6 | Apache-2.0 | Runtime | [LICENSE](third_party/licenses/npm/drizzle-orm-0.44.6/LICENSE) | [Official source](https://raw.githubusercontent.com/drizzle-team/drizzle-orm/0.44.6/LICENSE) |
| `hbs` | 4.3.0 | MIT | Runtime | [LICENSE](third_party/licenses/npm/hbs-4.3.0/LICENSE) | Published npm package |
| `jose` | 6.2.10 | MIT | Runtime | [LICENSE.md](third_party/licenses/npm/jose-6.2.10/LICENSE.md) | Published npm package |
| `oidc-provider` | 9.12.2 | MIT | Runtime | [LICENSE.md](third_party/licenses/npm/oidc-provider-9.12.2/LICENSE.md) | Published npm package |
| `reflect-metadata` | 0.1.14 | Apache-2.0 | Runtime | [CopyrightNotice.txt](third_party/licenses/npm/reflect-metadata-0.1.14/CopyrightNotice.txt), [LICENSE](third_party/licenses/npm/reflect-metadata-0.1.14/LICENSE) | Published npm package |
| `tslib` | 2.8.1 | 0BSD | Runtime | [CopyrightNotice.txt](third_party/licenses/npm/tslib-2.8.1/CopyrightNotice.txt), [LICENSE.txt](third_party/licenses/npm/tslib-2.8.1/LICENSE.txt) | Published npm package |
| `@hookform/resolvers` | 5.9.1 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/hookform--resolvers-5.9.1/LICENSE) | Published npm package |
| `@lark-apaas/client-toolkit` | 1.2.70 | MIT (package LICENSE title) | Frontend / development | [LICENSE](third_party/licenses/npm/lark-apaas--client-toolkit-1.2.70/LICENSE) | Published npm package |
| `@lark-apaas/coding-preset-vite-react` | 1.0.23 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/lark-apaas--coding-preset-vite-react-1.0.23/LICENSE) | Published npm package |
| `@lark-apaas/fullstack-presets` | 1.1.23 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/lark-apaas--fullstack-presets-1.1.23/LICENSE) | Published npm package |
| `@nestjs/cli` | 10.4.9 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/nestjs--cli-10.4.9/LICENSE) | Published npm package |
| `@radix-ui/react-accordion` | 1.2.20 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-accordion-1.2.20/LICENSE) | Published npm package |
| `@radix-ui/react-alert-dialog` | 1.1.23 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-alert-dialog-1.1.23/LICENSE) | Published npm package |
| `@radix-ui/react-aspect-ratio` | 1.1.15 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-aspect-ratio-1.1.15/LICENSE) | Published npm package |
| `@radix-ui/react-avatar` | 1.2.6 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-avatar-1.2.6/LICENSE) | Published npm package |
| `@radix-ui/react-checkbox` | 1.3.11 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-checkbox-1.3.11/LICENSE) | Published npm package |
| `@radix-ui/react-collapsible` | 1.1.20 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-collapsible-1.1.20/LICENSE) | Published npm package |
| `@radix-ui/react-context-menu` | 2.3.7 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-context-menu-2.3.7/LICENSE) | Published npm package |
| `@radix-ui/react-dialog` | 1.1.23 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-dialog-1.1.23/LICENSE) | Published npm package |
| `@radix-ui/react-dropdown-menu` | 2.1.24 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-dropdown-menu-2.1.24/LICENSE) | Published npm package |
| `@radix-ui/react-hover-card` | 1.1.23 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-hover-card-1.1.23/LICENSE) | Published npm package |
| `@radix-ui/react-label` | 2.1.15 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-label-2.1.15/LICENSE) | Published npm package |
| `@radix-ui/react-menubar` | 1.1.24 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-menubar-1.1.24/LICENSE) | Published npm package |
| `@radix-ui/react-navigation-menu` | 1.2.22 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-navigation-menu-1.2.22/LICENSE) | Published npm package |
| `@radix-ui/react-popover` | 1.1.23 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-popover-1.1.23/LICENSE) | Published npm package |
| `@radix-ui/react-progress` | 1.1.16 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-progress-1.1.16/LICENSE) | Published npm package |
| `@radix-ui/react-radio-group` | 1.4.7 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-radio-group-1.4.7/LICENSE) | Published npm package |
| `@radix-ui/react-scroll-area` | 1.2.18 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-scroll-area-1.2.18/LICENSE) | Published npm package |
| `@radix-ui/react-select` | 2.3.7 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-select-2.3.7/LICENSE) | Published npm package |
| `@radix-ui/react-separator` | 1.1.15 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-separator-1.1.15/LICENSE) | Published npm package |
| `@radix-ui/react-slider` | 1.4.7 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-slider-1.4.7/LICENSE) | Published npm package |
| `@radix-ui/react-slot` | 1.3.3 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-slot-1.3.3/LICENSE) | Published npm package |
| `@radix-ui/react-switch` | 1.3.7 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-switch-1.3.7/LICENSE) | Published npm package |
| `@radix-ui/react-tabs` | 1.1.21 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-tabs-1.1.21/LICENSE) | Published npm package |
| `@radix-ui/react-toggle` | 1.1.18 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-toggle-1.1.18/LICENSE) | Published npm package |
| `@radix-ui/react-toggle-group` | 1.1.19 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-toggle-group-1.1.19/LICENSE) | Published npm package |
| `@radix-ui/react-tooltip` | 1.2.16 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui--react-tooltip-1.2.16/LICENSE) | Published npm package |
| `@swc/cli` | 0.5.2 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/swc--cli-0.5.2/LICENSE) | [Official source](https://raw.githubusercontent.com/swc-project/pkgs/main/packages/cli/LICENSE) |
| `@swc/core` | 1.16.1 | Apache-2.0 | Frontend / development | [LICENSE](third_party/licenses/npm/swc--core-1.16.1/LICENSE) | Published npm package |
| `@tailwindcss/postcss` | 4.3.3 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/tailwindcss--postcss-4.3.3/LICENSE) | Published npm package |
| `@tailwindcss/typography` | 0.5.20 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/tailwindcss--typography-0.5.20/LICENSE) | Published npm package |
| `@types/crypto-js` | 4.2.2 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/types--crypto-js-4.2.2/LICENSE) | Published npm package |
| `@types/express` | 5.0.6 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/types--express-5.0.6/LICENSE) | Published npm package |
| `@types/hbs` | 4.0.5 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/types--hbs-4.0.5/LICENSE) | Published npm package |
| `@types/node` | 22.20.1 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/types--node-22.20.1/LICENSE) | Published npm package |
| `@types/oidc-provider` | 9.12.1 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/types--oidc-provider-9.12.1/LICENSE) | Published npm package |
| `@types/react` | 19.2.18 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/types--react-19.2.18/LICENSE) | Published npm package |
| `@types/react-dom` | 19.2.5 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/types--react-dom-19.2.5/LICENSE) | Published npm package |
| `autoprefixer` | 10.5.4 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/autoprefixer-10.5.4/LICENSE) | Published npm package |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Frontend / development | [LICENSE](third_party/licenses/npm/class-variance-authority-0.7.1/LICENSE) | Published npm package |
| `clsx` | 2.1.1 | MIT | Frontend / development | [license](third_party/licenses/npm/clsx-2.1.1/license) | Published npm package |
| `cmdk` | 1.1.1 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/cmdk-1.1.1/LICENSE.md) | Published npm package |
| `concurrently` | 9.2.4 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/concurrently-9.2.4/LICENSE) | Published npm package |
| `date-fns` | 4.4.0 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/date-fns-4.4.0/LICENSE.md) | Published npm package |
| `echarts` | 6.1.0 | Apache-2.0 | Frontend / development | [LICENSE](third_party/licenses/npm/echarts-6.1.0/LICENSE), [NOTICE](third_party/licenses/npm/echarts-6.1.0/NOTICE) | Published npm package |
| `echarts-for-react` | 3.0.6 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/echarts-for-react-3.0.6/LICENSE) | Published npm package |
| `embla-carousel-react` | 8.6.0 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/embla-carousel-react-8.6.0/LICENSE) | [Official source](https://raw.githubusercontent.com/davidjerleke/embla-carousel/v8.6.0/LICENSE) |
| `eslint` | 9.39.4 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/eslint-9.39.4/LICENSE) | Published npm package |
| `framer-motion` | 12.43.0 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/framer-motion-12.43.0/LICENSE.md) | Published npm package |
| `input-otp` | 1.5.0 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/input-otp-1.5.0/LICENSE) | Published npm package |
| `lodash` | 4.18.1 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/lodash-4.18.1/LICENSE) | Published npm package |
| `lucide-react` | 0.577.0 | ISC | Frontend / development | [LICENSE](third_party/licenses/npm/lucide-react-0.577.0/LICENSE) | Published npm package |
| `nanoid` | 5.1.16 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/nanoid-5.1.16/LICENSE) | Published npm package |
| `next-themes` | 0.4.6 | MIT | Frontend / development | [license.md](third_party/licenses/npm/next-themes-0.4.6/license.md) | Published npm package |
| `postcss` | 8.5.26 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/postcss-8.5.26/LICENSE) | Published npm package |
| `postcss-import` | 16.2.0 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/postcss-import-16.2.0/LICENSE) | Published npm package |
| `radix-ui` | 1.6.7 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/radix-ui-1.6.7/LICENSE) | Published npm package |
| `react` | 19.2.8 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/react-19.2.8/LICENSE) | Published npm package |
| `react-day-picker` | 9.14.0 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/react-day-picker-9.14.0/LICENSE) | Published npm package |
| `react-dom` | 19.2.8 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/react-dom-19.2.8/LICENSE) | Published npm package |
| `react-error-boundary` | 6.1.4 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/react-error-boundary-6.1.4/LICENSE) | Published npm package |
| `react-hook-form` | 7.87.0 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/react-hook-form-7.87.0/LICENSE) | Published npm package |
| `react-markdown` | 10.1.0 | MIT | Frontend / development | [license](third_party/licenses/npm/react-markdown-10.1.0/license) | Published npm package |
| `react-resizable-panels` | 3.0.6 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/react-resizable-panels-3.0.6/LICENSE) | [Official source](https://raw.githubusercontent.com/bvaughn/react-resizable-panels/main/LICENSE.md) |
| `react-router-dom` | 7.18.3 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/react-router-dom-7.18.3/LICENSE.md) | Published npm package |
| `recharts` | 2.15.4 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/recharts-2.15.4/LICENSE) | Published npm package |
| `remark-gfm` | 4.0.1 | MIT | Frontend / development | [license](third_party/licenses/npm/remark-gfm-4.0.1/license) | Published npm package |
| `rxjs` | 7.8.2 | Apache-2.0 | Frontend / development | [LICENSE.txt](third_party/licenses/npm/rxjs-7.8.2/LICENSE.txt) | Published npm package |
| `sonner` | 2.0.8 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/sonner-2.0.8/LICENSE.md) | Published npm package |
| `stylelint` | 17.15.0 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/stylelint-17.15.0/LICENSE) | Published npm package |
| `tailwind-merge` | 3.6.0 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/tailwind-merge-3.6.0/LICENSE.md) | Published npm package |
| `tailwindcss` | 4.3.3 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/tailwindcss-4.3.3/LICENSE) | Published npm package |
| `tw-animate-css` | 1.4.0 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/tw-animate-css-1.4.0/LICENSE) | Published npm package |
| `typescript` | 5.9.3 | Apache-2.0 | Frontend / development | [LICENSE.txt](third_party/licenses/npm/typescript-5.9.3/LICENSE.txt), [ThirdPartyNoticeText.txt](third_party/licenses/npm/typescript-5.9.3/ThirdPartyNoticeText.txt) | Published npm package |
| `typescript-eslint` | 8.69.0 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/typescript-eslint-8.69.0/LICENSE) | Published npm package |
| `uuid` | 11.0.5 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/uuid-11.0.5/LICENSE.md) | Published npm package |
| `vaul` | 1.1.2 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/vaul-1.1.2/LICENSE.md) | Published npm package |
| `vite` | 8.2.2 | MIT | Frontend / development | [LICENSE.md](third_party/licenses/npm/vite-8.2.2/LICENSE.md) | Published npm package |
| `zod` | 4.5.4 | MIT | Frontend / development | [LICENSE](third_party/licenses/npm/zod-4.5.4/LICENSE) | Published npm package |

## Redistributing built artifacts

Keep the applicable copyright notices and permission texts with redistributed third-party source or compiled components. In particular, Apache-2.0 components retain their Apache license and any supplied NOTICE/attribution files; preserve change notices if their source is modified. The copied ECharts NOTICE, TypeScript ThirdPartyNoticeText, and reflect-metadata CopyrightNotice are included alongside their licenses. MIT, ISC, BSD-2-Clause, and 0BSD components retain their supplied texts as listed above.

A distribution that includes node_modules, additional bundles, or a different native CLI must also retain the notices for the dependencies actually included in that distribution. Regenerate or review this inventory when changing direct dependency versions.

Third-party service names are used to identify integrations, not to claim sponsorship or endorsement.
