/**
 * The venue QR scanner, native half of the `venue-scanner` platform pair (AAP 0.3.4, AAP 0.5.8).
 *
 * Metro resolves the check-in screen's extensionless path to this file on iOS and Android and to
 * `venue-scanner.web.tsx` in the browser. On the two native platforms `expo-camera` 16.0.18 opens the camera, asks for
 * the foreground permission as the scanner mounts and reads the venue console's QR form of the same six digits the
 * manual field takes; the web half renders no scanner, which is why a screen renders `VenueScanner` unconditionally and
 * never asks which platform it is running on, manual entry being the guaranteed path everywhere.
 * A scanned payload is a code and nothing else. A payload that is not exactly `CODE_DIGITS` digits is refused here with
 * the banner and the announcement the field's own copy uses, and a payload already seen is ignored, because a
 * viewfinder decodes the same code on every frame it is shown in; no frame, image or payload is stored or logged.
 * Permission is foreground only and its usage strings come from the `expo-camera` config plugin in `app.config.ts`.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult, CameraViewProps } from 'expo-camera';
import { CODE_DIGITS, colors, radii, spacing, typography } from '@tablemate/shared';
import { Banner, Button, announce } from '../ui';
/** The shape of a venue check-in code, built from the contract's `CODE_DIGITS` so the two agree. */
const CODE_PATTERN = new RegExp(`^\\d{${CODE_DIGITS}}$`);
const CAMERA_STARTING_NOTICE = 'Starting the camera…';
const CAMERA_DENIED_NOTICE = 'Camera access is off. You can type the code instead.';
const NOT_A_CODE_NOTICE = "That isn't a venue code.";
const SCAN_LABEL = "Scan the venue's QR code";
const SCAN_PROPS = { label: SCAN_LABEL, variant: 'secondary', testID: 'checkin-scan' } as const;
const CLOSE_PROPS = { label: 'Close scanner', testID: 'checkin-scan-close' } as const;
const BAD_CODE = <Banner tone="error" message={NOT_A_CODE_NOTICE} testID="checkin-scan-invalid" />;
const CAMERA_PROPS: Partial<CameraViewProps> = {
  facing: 'back',
  accessibilityLabel: 'Camera viewfinder',
  barcodeScannerSettings: { barcodeTypes: ['qr'] },
};
/**
 * Props of {@link VenueScanner}: what the screen does with a code it did not type. The pair's two
 * halves both implement the component below, so a screen reads the same on every platform.
 */
export type VenueScannerProps = Readonly<{ onCode: (code: string) => void }>;
/**
 * The shape of the pair's one export: a component that renders either the scan control or nothing
 * at all, which is what the browser half returns (`venue-scanner.web.tsx`). Both halves name this
 * type, so a change to it that one half no longer implements fails the build at the half that lags
 * rather than at a call site that reads both platforms the same way (AAP 0.5.1).
 */
export type VenueScannerComponent = (props: VenueScannerProps) => ReactElement | null;
type CameraScannerProps = Readonly<{ onCode: (code: string) => void; onClose: () => void }>;
/**
 * The open viewfinder: the camera once the permission is granted, the permission request once the
 * scanner mounts, and the notice that explains a refusal instead of a control.
 *
 * The request is made here rather than on the screen, so it is asked for only when the user opens
 * the scanner and never while the form is merely on screen. The camera reads continuously until
 * the close control is pressed or a code is handed over, and the duplicate-payload guard is what
 * keeps one frame from filling the field twice.
 */
function CameraScanner({ onCode, onClose }: CameraScannerProps): ReactElement {
  const [permission, requestPermission] = useCameraPermissions();
  const [invalid, setInvalid] = useState(false);
  const lastPayload = useRef<string | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    const undecided = permission !== null && !permission.granted && permission.canAskAgain;
    if (!undecided || asked.current) return;
    asked.current = true;
    void requestPermission().catch(() => undefined);
  }, [permission, requestPermission]);
  const handleScan = (scan: BarcodeScanningResult): void => {
    const payload = scan.data.trim();
    if (payload === lastPayload.current) return;
    lastPayload.current = payload;
    if (CODE_PATTERN.test(payload)) {
      onCode(payload);
      onClose();
    } else {
      setInvalid(true);
      announce(NOT_A_CODE_NOTICE);
    }
  };
  return (
    <View style={styles.scanner}>
      {permission === null ? (
        <Text style={styles.notice}>{CAMERA_STARTING_NOTICE}</Text>
      ) : permission.granted ? (
        <CameraView style={styles.camera} {...CAMERA_PROPS} onBarcodeScanned={handleScan} />
      ) : (
        <Banner tone="error" message={CAMERA_DENIED_NOTICE} testID="checkin-camera-denied" />
      )}
      {invalid ? BAD_CODE : null}
      <Button {...CLOSE_PROPS} variant="secondary" onPress={onClose} />
    </View>
  );
}

/**
 * The venue scanner on iOS and Android: the control that opens the camera, and the viewfinder it
 * opens in its place, which reports one scanned code through `onCode`. The browser half renders
 * nothing, so a screen needs no platform check of its own (AAP 0.3.4).
 *
 */
export const VenueScanner: VenueScannerComponent = ({ onCode }) => {
  const [scanning, setScanning] = useState(false);
  if (!scanning) return <Button {...SCAN_PROPS} onPress={() => setScanning(true)} />;
  return <CameraScanner onCode={onCode} onClose={() => setScanning(false)} />;
};

const styles = StyleSheet.create({
  notice: { ...typography.body, color: colors.textMuted },
  scanner: { gap: spacing.md },
  camera: { width: '100%', aspectRatio: 1, borderRadius: radii.md, overflow: 'hidden' },
});
