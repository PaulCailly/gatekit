// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://paulcailly.github.io',
	base: '/repo-harness',
	integrations: [
		starlight({
			title: 'repo-harness',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/PaulCailly/repo-harness' }],
			sidebar: [
				{ label: 'Getting Started', slug: 'index' },
				{ label: 'CLI Reference', slug: 'cli' },
				{
					label: 'Gates',
					items: [
						{ label: 'Quality', slug: 'gates/quality' },
						{ label: 'Compliance', slug: 'gates/compliance' },
						{ label: 'Bots', slug: 'gates/bots' },
					],
				},
				{ label: 'Policy Authoring', slug: 'policy-authoring' },
			],
		}),
	],
});
