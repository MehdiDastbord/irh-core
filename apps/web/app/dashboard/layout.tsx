import type { ReactNode } from 'react';
import DashboardLayout from '@/components/dashboard-shell';

export default function Layout({ children }: { children: ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
