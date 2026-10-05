<template>
  <div class="min-h-screen p-8">
    <div class="mx-auto flex max-w-7xl flex-col gap-8 lg:flex-row">
      <aside
        class="w-full shrink-0 lg:w-64"
        aria-label="Sidebar"
      >
        <slot name="aside" />
      </aside>
      <main
        id="main-content"
        role="main"
        class="min-w-0 grow"
      >
        <slot />
      </main>
    </div>
  </div>
</template>
