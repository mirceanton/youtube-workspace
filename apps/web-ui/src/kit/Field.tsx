import { useId, type ComponentProps, type ReactNode } from "react";
import { cx } from "@/lib/cx.ts";

interface FieldFrameProps {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Visually hide the label (it stays available to assistive technology). */
  hideLabel?: boolean;
  className?: string;
}

interface ControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  required: boolean | undefined;
}

const CONTROL =
  "min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-base text-ink " +
  "placeholder:text-ink-muted disabled:cursor-not-allowed disabled:opacity-60 " +
  "aria-[invalid=true]:border-danger";

function Frame({
  label,
  hint,
  error,
  required,
  hideLabel,
  className,
  render,
}: FieldFrameProps & { render: (control: ControlProps) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className={cx("grid gap-1.5", className)}>
      <label htmlFor={id} className={cx("text-sm font-medium", hideLabel && "sr-only")}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-danger">
            {" "}
            *
          </span>
        ) : null}
      </label>
      {render({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
        required: required || undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps
  extends FieldFrameProps, Omit<ComponentProps<"input">, "className" | "required"> {
  /** Class names of the `<input>` itself; `className` styles the wrapper. */
  inputClassName?: string;
}

/** Label + `<input>` with hint and error text wired up for assistive technology. */
export function TextField({
  label,
  hint,
  error,
  required,
  hideLabel,
  className,
  inputClassName,
  ...input
}: TextFieldProps) {
  return (
    <Frame
      {...{ label, hint, error, required, hideLabel, className }}
      render={(control) => (
        <input {...input} {...control} className={cx(CONTROL, inputClassName)} />
      )}
    />
  );
}

export interface TextAreaFieldProps
  extends FieldFrameProps, Omit<ComponentProps<"textarea">, "className" | "required"> {
  inputClassName?: string;
}

export function TextAreaField({
  label,
  hint,
  error,
  required,
  hideLabel,
  className,
  inputClassName,
  rows = 4,
  ...input
}: TextAreaFieldProps) {
  return (
    <Frame
      {...{ label, hint, error, required, hideLabel, className }}
      render={(control) => (
        <textarea
          {...input}
          {...control}
          rows={rows}
          className={cx(CONTROL, "resize-y", inputClassName)}
        />
      )}
    />
  );
}

export interface SelectFieldProps
  extends FieldFrameProps, Omit<ComponentProps<"select">, "className" | "required"> {
  inputClassName?: string;
}

export function SelectField({
  label,
  hint,
  error,
  required,
  hideLabel,
  className,
  inputClassName,
  children,
  ...input
}: SelectFieldProps) {
  return (
    <Frame
      {...{ label, hint, error, required, hideLabel, className }}
      render={(control) => (
        <select {...input} {...control} className={cx(CONTROL, inputClassName)}>
          {children}
        </select>
      )}
    />
  );
}
