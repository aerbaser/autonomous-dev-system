<script lang="ts">
  // Stub component — will be expanded in the email list task.
  import type { EmailCategory } from '$lib/types.js';
  import CategoryBadge from './CategoryBadge.svelte';

  interface EmailRowData {
    subject: string;
    from_name: string;
    date: string;
    category: EmailCategory | null;
  }

  interface Props {
    email: EmailRowData;
  }

  let { email }: Props = $props();

  // Format ISO date string to a short human-readable form
  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
</script>

<div class="flex items-center gap-3 border-b border-gray-200 px-4 py-3 hover:bg-gray-50">
  <!-- Sender -->
  <span class="w-40 shrink-0 truncate text-sm font-medium text-gray-900">
    {email.from_name}
  </span>

  <!-- Subject -->
  <span class="min-w-0 flex-1 truncate text-sm text-gray-700">
    {email.subject}
  </span>

  <!-- Category badge (small variant) -->
  <CategoryBadge category={email.category} size="sm" />

  <!-- Date -->
  <span class="shrink-0 text-xs text-gray-400">
    {formatDate(email.date)}
  </span>
</div>
