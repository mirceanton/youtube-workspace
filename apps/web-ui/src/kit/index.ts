// The UI kit. Features import from "@/kit"; the app shell imports the individual files, so a
// feature-only dependency (zod through NotesPanel) never reaches the initial bundle.
export { Alert } from "./Alert.tsx";
export { Badge, type Tone } from "./Badge.tsx";
export { Button, type ButtonProps } from "./Button.tsx";
export { buttonClasses, type ButtonSize, type ButtonVariant } from "./button-styles.ts";
export { Card } from "./Card.tsx";
export { ConflictDialog, type ConflictDialogProps } from "./ConflictDialog.tsx";
export { Dialog, type DialogProps } from "./Dialog.tsx";
export {
  SelectField,
  TextAreaField,
  TextField,
  type SelectFieldProps,
  type TextAreaFieldProps,
  type TextFieldProps,
} from "./Field.tsx";
export { useWideLayout } from "./layout.ts";
export { LastChangedBy, type LastChangedByProps } from "./LastChangedBy.tsx";
export { MarkdownView, type MarkdownViewProps } from "./MarkdownView.tsx";
export { NotesPanel, type NotesPanelProps } from "./NotesPanel.tsx";
export { notesQueryKey } from "./notes-keys.ts";
export { PageHeader, type PageHeaderProps } from "./PageHeader.tsx";
export { RequireAccess, type RequireAccessProps } from "./RequireAccess.tsx";
export { Spinner } from "./Spinner.tsx";
export {
  EmptyState,
  ErrorState,
  LoadingState,
  type EmptyStateProps,
  type ErrorStateProps,
  type LoadingStateProps,
} from "./states.tsx";
export type { IconComponent } from "./types.ts";
export { useOnlineStatus } from "./useOnlineStatus.ts";
export { WriteGuard, type WriteGuardProps } from "./WriteGuard.tsx";
export { useWriteGuard, type WriteBlockReason, type WriteGuardState } from "./useWriteGuard.ts";
export { Sparkline, type SparklineProps } from "./charts/Sparkline.tsx";
export { TimeSeriesChart, type TimeSeriesChartProps } from "./charts/TimeSeriesChart.tsx";
export type { ChartMarker, ChartPoint, ChartSeries, XKind } from "./charts/series.ts";
