<script lang="ts">
  // Stub component — will be expanded in the email detail task.
  import type { EmailCategory } from '$lib/types.js';
  import CategoryBadge from './CategoryBadge.svelte';

  interface EmailDetailData {
    subject: string;
    from_name: string;
    from_address: string;
    date: string;
    category: EmailCategory | null;
    body_html: string | null;
    body_text: string | null;
  }

  interface Props {
    email: EmailDetailData;
  }

  let { email }: Props = $props();

  // Format ISO date string to a locale-aware full datetime
  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
</script>

<article class="flex flex-col gap-4 p-6">
  <!-- Header -->
  <header class="border-b border-gray-200 pb-4">
    <div class="mb-2 flex items-start justify-between gap-4">
      <h1 class="text-xl font-semibold text-gray-900">{email.subject}</h1>
      <CategoryBadge category={email.category} size="md" />
    </div>

    <div class="flex flex-col gap-1 text-sm text-gray-600">
      <span>
        <span class="font-medium">From:</span>
        {email.from_name}
        {#if email.from_address}
          &lt;{email.from_address}&gt;
        {/if}
      </span>
      <span>
        <span class="font-medium">Date:</span>
        {formatDate(email.date)}
      </span>
    </div>
  </header>

  <!-- Body: prefer HTML, fall back to plain text -->
  <div class="min-w-0">
    {#if email.body_html}
      <!-- NOTE: body_html will be rendered in a sandboxed iframe in the full implementation -->
      {@html email.body_html}
    {:else if email.body_text}
      <pre class="whitespace-pre-wrap text-sm text-gray-800">{email.body_text}</pre>
    {:else}
      <p class="text-sm italic text-gray-400">No content available.</p>
    {/if}
  </div>
</article>
