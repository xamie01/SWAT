'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LpIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/lp/discover');
  }, [router]);

  return (
    <div className="p-12 text-center text-xs text-on-surface-variant font-mono">
      Redirecting to LP Discover feed...
    </div>
  );
}
