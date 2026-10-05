<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";
import type { TablesInsert } from "~~/shared/types/database";

definePageMeta({ middleware: "can", permission: "products.view" });
useSeoMeta({ title: "Products — The Reserve" });

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  price_cents: number;
  cost_cents: number | null;
  stock_quantity: number;
  taxable: boolean;
  active: boolean;
}

const { data: products, refresh } = await useAsyncData(
  "products-list",
  async () => {
    const { data, error } = await supabase
      .from("products")
      .select(
        "id, name, description, sku, price_cents, cost_cents, stock_quantity, taxable, active",
      )
      .order("name");
    if (error) throw error;
    return (data ?? []) as ProductRow[];
  },
);

const search = ref("");
const showInactive = ref(false);
const manage = computed(() => can("products.manage"));

// ---------------------------------------------------------------------------
// TanStack table columns (Margin only for products.manage holders)
// ---------------------------------------------------------------------------
const productColumns = computed(() => [
  {
    id: "product",
    accessorFn: (p: ProductRow) => p.name,
    header: "Product",
    enableSorting: true,
  },
  {
    id: "price",
    accessorFn: (p: ProductRow) => p.price_cents,
    header: "Price",
    enableSorting: true,
  },
  ...(manage.value
    ? [
        {
          id: "margin",
          accessorFn: (p: ProductRow) =>
            p.cost_cents != null && p.price_cents > 0
              ? (p.price_cents - p.cost_cents) / p.price_cents
              : -1,
          header: "Margin",
          enableSorting: true,
        },
      ]
    : []),
  {
    id: "stock",
    accessorFn: (p: ProductRow) => p.stock_quantity,
    header: "Stock",
    enableSorting: true,
  },
  // No header at all, rather than header: "" — TanStack Table v9 renders an
  // empty string as an empty text node on the client while the server emits
  // nothing, which is a hydration mismatch on every page with this column.
  { id: "actions", enableSorting: false },
]);

const visibleProducts = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (products.value ?? []).filter((p) => {
    if (!showInactive.value && !p.active) return false;
    if (!q) return true;
    return [p.name, p.sku ?? "", p.description ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
});

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

function marginPct(product: ProductRow): string | null {
  if (product.cost_cents == null || product.price_cents === 0) return null;
  return `${Math.round(((product.price_cents - product.cost_cents) / product.price_cents) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------
const ProductSchema = z.object({
  name: z.string().min(1, "Name is required"),
  sku: z.string().optional(),
  priceDollars: z.coerce.number().min(0, "Price can't be negative"),
  costDollars: z.coerce.number().min(0).optional(),
  stock: z.coerce.number().int().min(0),
});

const { handleSubmit, isSubmitting, resetForm, setValues } = useForm({
  validationSchema: toTypedSchema(ProductSchema),
});

const dialogOpen = ref(false);
const editingId = ref<string | null>(null);
const description = ref("");
const taxable = ref(true);

function openCreate() {
  editingId.value = null;
  resetForm({
    values: {
      name: "",
      sku: "",
      priceDollars: 0,
      costDollars: undefined,
      stock: 0,
    },
  });
  description.value = "";
  taxable.value = true;
  dialogOpen.value = true;
}

function openEdit(product: ProductRow) {
  editingId.value = product.id;
  setValues({
    name: product.name,
    sku: product.sku ?? "",
    priceDollars: product.price_cents / 100,
    costDollars:
      product.cost_cents != null ? product.cost_cents / 100 : undefined,
    stock: product.stock_quantity,
  });
  description.value = product.description ?? "";
  taxable.value = product.taxable;
  dialogOpen.value = true;
}

const saveProduct = handleSubmit(async (values) => {
  const payload: Omit<TablesInsert<"products">, "organization_id"> = {
    name: values.name,
    sku: values.sku || null,
    description: description.value || null,
    price_cents: Math.round(values.priceDollars * 100),
    cost_cents:
      values.costDollars != null ? Math.round(values.costDollars * 100) : null,
    stock_quantity: values.stock,
    taxable: taxable.value,
  };

  if (editingId.value) {
    const { error } = await supabase
      .from("products")
      .update(payload)
      .eq("id", editingId.value);
    if (error) return toast.error("Could not save product", error.message);
  } else {
    const { data: orgId } = await supabase.rpc("current_org_id");
    if (!orgId) return toast.error("Session issue — please refresh");

    const { error } = await supabase
      .from("products")
      .insert({ ...payload, organization_id: orgId });
    if (error) {
      if (error.code === "23505") {
        return toast.error(
          "Duplicate name",
          "A product with this name already exists.",
        );
      }
      return toast.error("Could not create product", error.message);
    }
  }

  toast.success(
    editingId.value ? "Product updated" : "Product added",
    values.name,
  );
  dialogOpen.value = false;
  await refresh();
});

async function toggleActive(product: ProductRow) {
  const { error } = await supabase
    .from("products")
    .update({ active: !product.active })
    .eq("id", product.id);
  if (error) return toast.error("Could not update product", error.message);
  toast.success(
    product.active ? "Product deactivated" : "Product activated",
    product.name,
  );
  await refresh();
}
</script>

<template>
  <div class="mx-auto flex h-[calc(100dvh-3rem)] w-full flex-col p-6 md:p-10">
    <!-- Same layout as clients/index.vue (the reference, with the reasoning):
         the root owns the viewport below the h-12 layout header, everything
         above the table is shrink-0, and the table card is the one thing
         allowed to shrink — long lists scroll inside it with the pager at
         the window's bottom edge, short lists keep it content-sized. -->
    <div
      class="grid shrink-0 grid-cols-1 gap-5 md:flex md:items-center md:justify-between"
    >
      <div>
        <h1 class="text-2xl font-semibold">Products</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Retail inventory — stock counts decrease automatically when items sell
          at checkout.
        </p>
      </div>
      <UiButton v-if="manage" size="sm" @click="openCreate">
        <Icon name="lucide:plus" class="size-4" />
        New product
      </UiButton>
    </div>

    <div class="mt-6 flex shrink-0 flex-wrap items-center gap-4">
      <UiInput
        v-model="search"
        placeholder="Search name, SKU…"
        class="max-w-xs"
      />
      <label
        class="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm"
      >
        <input
          v-model="showInactive"
          type="checkbox"
          class="size-4 accent-primary"
        />
        Show inactive
      </label>
    </div>

    <div
      class="mt-4 flex min-h-0 flex-col overflow-hidden rounded-md border bg-card [&>div:first-child]:flex [&>div:first-child]:min-h-0 [&>div:first-child]:flex-col [&>div:last-child]:shrink-0 **:data-[slot=table-container]:min-h-0 **:data-[slot=table-container]:overflow-y-auto **:data-[slot=table-head]:sticky **:data-[slot=table-head]:top-0 **:data-[slot=table-head]:z-10 **:data-[slot=table-head]:bg-card **:data-[slot=table-head]:shadow-[inset_0_-1px_0_var(--border)] [&_thead_tr]:border-b-0"
    >
      <UiTanStackTable
        :data="visibleProducts"
        :columns="productColumns"
        :show-selected-count="false"
        :show-rows-per-page="false"
      >
        <template #product-cell="{ row }">
          <p
            class="font-medium"
            :class="
              !row.original.active && 'text-muted-foreground line-through'
            "
          >
            {{ row.original.name }}
          </p>
          <p class="text-muted-foreground text-xs">
            <span v-if="row.original.sku">{{ row.original.sku }} · </span>
            <span v-if="!row.original.taxable">non-taxable · </span>
            <span v-if="row.original.description">{{
              row.original.description
            }}</span>
          </p>
        </template>

        <template #price-cell="{ row }">
          <span class="tabular-nums">{{
            dollars(row.original.price_cents)
          }}</span>
        </template>

        <template #margin-cell="{ row }">
          <span class="text-muted-foreground tabular-nums">
            {{ marginPct(row.original) ?? "—" }}
          </span>
        </template>

        <template #stock-cell="{ row }">
          <UiBadge
            variant="outline"
            class="min-w-9 justify-center rounded-full tabular-nums"
            :class="
              row.original.stock_quantity === 0
                ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/50 dark:text-red-400'
                : row.original.stock_quantity <= 5
                  ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-400'
                  : ''
            "
          >
            {{ row.original.stock_quantity }}
          </UiBadge>
        </template>

        <template #actions-cell="{ row }">
          <div v-if="manage" class="flex justify-end gap-1">
            <UiTooltip>
              <UiTooltipTrigger as-child>
                <UiButton
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground"
                  :aria-label="`Edit ${row.original.name}`"
                  @click="openEdit(row.original)"
                >
                  <Icon name="lucide:pencil" class="size-4" />
                </UiButton>
              </UiTooltipTrigger>
              <UiTooltipContent>Edit product</UiTooltipContent>
            </UiTooltip>

            <UiTooltip>
              <UiTooltipTrigger as-child>
                <UiButton
                  variant="ghost"
                  size="icon-sm"
                  :class="
                    row.original.active
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  "
                  :aria-label="
                    row.original.active
                      ? `Deactivate ${row.original.name}`
                      : `Activate ${row.original.name}`
                  "
                  @click="toggleActive(row.original)"
                >
                  <Icon
                    :name="
                      row.original.active
                        ? 'lucide:archive'
                        : 'lucide:archive-restore'
                    "
                    class="size-4"
                  />
                </UiButton>
              </UiTooltipTrigger>
              <UiTooltipContent>
                {{
                  row.original.active
                    ? "Deactivate product"
                    : "Activate product"
                }}
              </UiTooltipContent>
            </UiTooltip>
          </div>
        </template>
      </UiTanStackTable>
    </div>

    <!-- Create / edit dialog -->
    <UiDialog v-model:open="dialogOpen">
      <UiDialogContent class="sm:max-w-md">
        <UiDialogHeader>
          <UiDialogTitle>{{
            editingId ? "Edit product" : "New product"
          }}</UiDialogTitle>
        </UiDialogHeader>
        <form @submit="saveProduct">
          <fieldset :disabled="isSubmitting" class="grid gap-4">
            <UiVeeInput
              label="Name"
              name="name"
              placeholder="Lavender Body Lotion"
            />
            <div>
              <label class="text-sm font-medium" for="p-desc"
                >Description</label
              >
              <textarea
                id="p-desc"
                v-model="description"
                rows="2"
                class="border-input mt-1.5 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <UiVeeInput label="SKU (optional)" name="sku" />
              <UiVeeInput
                label="Stock on hand"
                name="stock"
                type="number"
                min="0"
              />
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <UiVeeInput
                label="Price ($)"
                name="priceDollars"
                type="number"
                step="0.01"
                min="0"
              />
              <UiVeeInput
                label="Cost ($, optional)"
                name="costDollars"
                type="number"
                step="0.01"
                min="0"
              />
            </div>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                v-model="taxable"
                type="checkbox"
                class="size-4 accent-primary"
              />
              Taxable (retail goods are taxable in Georgia)
            </label>
            <UiDialogFooter>
              <UiButton
                type="button"
                variant="outline"
                @click="dialogOpen = false"
              >
                Cancel
              </UiButton>
              <UiButton
                type="submit"
                :text="isSubmitting ? 'Saving…' : 'Save product'"
              />
            </UiDialogFooter>
          </fieldset>
        </form>
      </UiDialogContent>
    </UiDialog>
  </div>
</template>
