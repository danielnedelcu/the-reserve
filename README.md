# The Reserve

A Nuxt 4 application built with TypeScript, Tailwind CSS, and Pinia.

## Stack

- [Nuxt](https://nuxt.com) 4.5.0 (TypeScript)
- [Tailwind CSS](https://tailwindcss.com) v4 (via `@tailwindcss/vite`)
- [Supabase](https://supabase.com) via `@nuxtjs/supabase`
- [Pinia](https://pinia.vuejs.org) for state management
- [ESLint](https://eslint.org) via `@nuxt/eslint`
- [Vitest](https://vitest.dev) + `@nuxt/test-utils` for testing

## Setup

```bash
npm install
cp .env.example .env # then fill in your Supabase credentials
```

## Development

```bash
npm run dev
```

The app runs at `http://localhost:3000`.

## Scripts

| Script                  | Description              |
| ----------------------- | ------------------------ |
| `npm run dev`           | Start dev server         |
| `npm run build`         | Build for production     |
| `npm run generate`      | Generate static site     |
| `npm run preview`       | Preview production build |
| `npm run lint`          | Run ESLint               |
| `npm run lint:fix`      | Run ESLint with auto-fix |
| `npm run test`          | Run tests once           |
| `npm run test:watch`    | Run tests in watch mode  |
| `npm run test:coverage` | Run tests with coverage  |

## Theming

- `app/assets/css/main.css` - Tailwind configuration and global base styles.

## Project Structure

```
app/
  app.vue            # Root component
  assets/css/        # Tailwind + theme CSS
  pages/             # File-based routing
  stores/            # Pinia stores
tests/               # Vitest tests
```
