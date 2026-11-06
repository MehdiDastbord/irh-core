'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { sectionById } from '@/lib/sections';
import { SectionView } from '@/components/section-view';
import { EmptyState } from '@/components/ui';

export default function GuildSectionPage() {
  const params = useParams<{ guildId: string; section: string }>();
  const section = sectionById(params.section);
  if (!section || section.id === 'overview') {
    return (
      <EmptyState
        title="Page not found"
        description="That dashboard page does not exist."
        action={
          <Link href={`/dashboard/g/${params.guildId}`} className="btn-secondary">
            Back to overview
          </Link>
        }
      />
    );
  }
  return <SectionView sectionId={section.id} guildId={params.guildId} />;
}
