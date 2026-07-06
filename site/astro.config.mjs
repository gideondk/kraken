import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';
import lucode from 'lucode-starlight';

// Override via SITE_URL / SITE_BASE at build time (CI / GitHub Pages).
const SITE = process.env.SITE_URL ?? 'https://kraken.dev';
const BASE = process.env.SITE_BASE ?? undefined;

export default defineConfig({
  site: SITE,
  base: BASE,
  integrations: [
    starlight({
      title: 'Kraken',
      description:
        'One head, many arms — the fleet layer for coding agents. ' +
        'Every agent tool ships code faster; Kraken is the merge authority ' +
        'that decides whether it lands.',
      plugins: [lucode()],
      customCss: ['./src/styles/kraken.css'],
      logo: {
        src: './src/assets/kraken-mark.svg',
        alt: 'Kraken',
      },
      favicon: '/favicon.svg',
      pagefind: true,
      lastUpdated: true,
      pagination: true,
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/gideondk/kraken' },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Install', link: '/start/install/' },
            { label: 'Onboard a repository', link: '/start/onboard/' },
            { label: 'Your first run', link: '/start/first-run/' },
            { label: 'The bridge', link: '/start/bridge/' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'The journal', link: '/concepts/journal/' },
            { label: 'Task contracts', link: '/concepts/contracts/' },
            { label: 'The merge train', link: '/concepts/merge-train/' },
            { label: 'Auto-heal', link: '/concepts/auto-heal/' },
            { label: 'The judge', link: '/concepts/judge/' },
            { label: 'Arms', link: '/concepts/arms/' },
            { label: 'The findings bus', link: '/concepts/findings-bus/' },
            { label: 'Decisions', link: '/concepts/decisions/' },
          ],
        },
        {
          label: 'The bridge',
          items: [
            { label: 'A visual tour', link: '/bridge/tour/' },
          ],
        },
        {
          label: 'Going further',
          items: [
            { label: 'Campaigns', link: '/guides/campaigns/' },
            { label: 'The Claude Code plugin', link: '/guides/claude-code-plugin/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration (kraken.toml)', link: '/reference/configuration/' },
            { label: 'Philosophy', link: '/reference/philosophy/' },
          ],
        },
      ],
    }),
    mdx(),
  ],
});
