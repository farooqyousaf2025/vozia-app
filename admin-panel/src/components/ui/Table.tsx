import type { HTMLAttributes, ReactNode } from 'react';

// Composable table primitives — pages assemble their own columns, so sticky
// headers and hover rows stay consistent without a table abstraction.

interface TableProps {
  className?: string;
  children: ReactNode;
}

export function Table({ className = '', children }: TableProps) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function THead({ className = '', children }: TableProps) {
  return (
    <thead className={className}>
      <tr className="border-b border-edge/60 bg-elevated/60">{children}</tr>
    </thead>
  );
}

export function TBody({ children }: TableProps) {
  return <tbody className="divide-y divide-edge/40">{children}</tbody>;
}

interface RowProps extends HTMLAttributes<HTMLTableRowElement> {
  active?: boolean;
}

export function Tr({ active = false, className = '', children, ...rest }: RowProps) {
  return (
    <tr
      className={`transition-colors hover:bg-elevated/40 ${active ? 'bg-violet-500/10' : ''} ${className}`}
      {...rest}
    >
      {children}
    </tr>
  );
}

interface CellProps extends HTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
  width?: string;
  colSpan?: number;
}

const alignClasses = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

export function Th({ align = 'left', width, className = '', children, ...rest }: CellProps) {
  return (
    <th
      style={width !== undefined ? { width } : undefined}
      className={`whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-faint ${alignClasses[align]} ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ align = 'left', width, className = '', children, ...rest }: CellProps) {
  return (
    <td
      style={width !== undefined ? { width } : undefined}
      className={`px-4 py-3 align-middle text-muted ${alignClasses[align]} ${className}`}
      {...rest}
    >
      {children}
    </td>
  );
}
