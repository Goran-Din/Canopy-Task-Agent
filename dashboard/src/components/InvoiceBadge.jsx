const STATUS_STYLES = {
  not_invoiced: { bg: '#F3F4F6', text: '#6B7280' },
  invoiced:     { bg: '#FEF3C7', text: '#D97706' },
  paid:         { bg: '#D1FAE5', text: '#059669' },
  overdue:      { bg: '#FEE2E2', text: '#DC2626' },
};

const DIVISION_BORDER = {
  landscape_project: '#2563EB',
  hardscape: '#0D9488',
};

const STATUS_LABEL = {
  not_invoiced: 'Not Invoiced',
  invoiced: 'Invoiced',
  paid: 'Paid',
  overdue: 'Overdue',
};

function formatAmount(amount) {
  if (amount == null) return '';
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function InvoiceBadge({ invoice, division }) {
  const status = invoice?.status || 'not_invoiced';
  const style = STATUS_STYLES[status] || STATUS_STYLES.not_invoiced;
  const borderColor = DIVISION_BORDER[division] || DIVISION_BORDER.landscape_project;

  return (
    <div
      className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs mt-2"
      style={{
        backgroundColor: style.bg,
        color: style.text,
        borderLeft: `3px solid ${borderColor}`,
      }}
    >
      <span className="font-semibold">{STATUS_LABEL[status]}</span>

      {status === 'invoiced' && invoice && (
        <>
          {invoice.invoice_number && <span>{invoice.invoice_number}</span>}
          {invoice.invoice_amount != null && <span>{formatAmount(invoice.invoice_amount)}</span>}
          {invoice.due_date && <span>Due: {invoice.due_date}</span>}
        </>
      )}

      {status === 'paid' && invoice && (
        <>
          {invoice.invoice_number && <span>{invoice.invoice_number}</span>}
          {invoice.paid_date && <span>Paid: {invoice.paid_date}</span>}
        </>
      )}

      {status === 'overdue' && invoice && (
        <>
          {invoice.invoice_number && <span>{invoice.invoice_number}</span>}
          {invoice.invoice_amount != null && <span>{formatAmount(invoice.invoice_amount)}</span>}
          {invoice.due_date && <span>Due: {invoice.due_date}</span>}
        </>
      )}
    </div>
  );
}
