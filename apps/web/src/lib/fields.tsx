import { TextArea, type TextAreaProps } from "@astryxdesign/core/TextArea";
import { TextInput, type TextInputProps } from "@astryxdesign/core/TextInput";
import { type ComponentProps, useState } from "react";

type TextFieldProps = TextInputProps &
  Pick<ComponentProps<"input">, "required" | "minLength" | "maxLength">;

export function TextField({
  required,
  isRequired,
  minLength,
  maxLength,
  width = "min(100%, 40rem)",
  ...props
}: TextFieldProps) {
  const effectiveRequired = required ?? isRequired;
  const constraints = { required: effectiveRequired, minLength, maxLength };
  return (
    <TextInput
      {...props}
      {...constraints}
      {...(effectiveRequired === undefined ? {} : { isRequired: effectiveRequired })}
      width={width}
    />
  );
}

type CurrentPasswordFieldProps = Omit<
  ComponentProps<typeof TextField>,
  "type" | "autoComplete" | "isReadOnly" | "onFocus" | "onPointerDown"
>;

/**
 * A password field that password managers cannot fill when the page loads.
 *
 * Chromium and Safari ignore `autocomplete="off"` on password fields and fill
 * the saved login anyway. Browsers skip read-only controls, so this field starts
 * read-only and unlocks on the first focus or pointer press, before typing or
 * pasting can begin. `one-time-code` also tells Chromium and Safari that the
 * value is not a saved login password; Firefox does not implement that hint yet,
 * so the read-only start is the cross-browser guarantee.
 */
export function CurrentPasswordField(props: CurrentPasswordFieldProps) {
  const [isLocked, setIsLocked] = useState(true);
  return (
    <TextField
      {...props}
      type="password"
      autoComplete="one-time-code"
      isReadOnly={isLocked}
      onFocus={() => setIsLocked(false)}
      onPointerDown={() => setIsLocked(false)}
    />
  );
}

export function TextAreaField({
  required,
  isRequired,
  width = "min(100%, 40rem)",
  ...props
}: TextAreaProps & Pick<ComponentProps<"textarea">, "required">) {
  const effectiveRequired = required ?? isRequired;
  const constraints = { required: effectiveRequired };
  return (
    <TextArea
      {...props}
      {...constraints}
      {...(effectiveRequired === undefined ? {} : { isRequired: effectiveRequired })}
      width={width}
    />
  );
}
