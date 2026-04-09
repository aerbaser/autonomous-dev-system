<script lang="ts">
  import type { EmailCategory } from '$lib/types.js';

  interface Props {
    category: string | null;
    size?: 'sm' | 'md';
  }

  let { category = null, size = 'md' }: Props = $props();

  // Map each known category to a Tailwind background color class
  const colorMap: Record<string, string> = {
    Work: 'bg-blue-600',
    Personal: 'bg-green-600',
    Newsletters: 'bg-purple-600',
    Transactions: 'bg-orange-600',
    Spam: 'bg-red-600',
  };

  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-3 py-1',
  };

  // Derived values — recomputed whenever props change
  const colorClass = $derived(
    category != null ? (colorMap[category] ?? 'bg-gray-600') : ''
  );
  const sizeClass = $derived(size ? sizeClasses[size] : sizeClasses.md);
</script>

{#if category != null}
  <span
    class="inline-flex items-center rounded-full font-semibold text-white {colorClass} {sizeClass}"
  >
    {category}
  </span>
{/if}
