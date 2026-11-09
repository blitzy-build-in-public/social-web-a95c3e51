/** The auth route group: sign-in, check-email and the age gate in one stack (AAP 0.5.8). */
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { colors, fontWeights, typography } from '@tablemate/shared';
import { renderWebHeaderLeft } from '../../src/ui/HeaderBackButton';
const SCREEN_OPTIONS = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.text,
  headerTitleStyle: { fontSize: typography.title.fontSize, fontWeight: fontWeights.bold },
  contentStyle: { backgroundColor: colors.background },
  // Web only: where the measured request of the header's own back control comes from, on the screens
  // a signed-out traveler walks through. Native keeps the platform header (AAP 0.5.8).
  ...(Platform.OS === 'web' ? { headerLeft: renderWebHeaderLeft } : {}),
};
const AGE_GATE = { title: 'Before you start', gestureEnabled: false, headerBackVisible: false };
export default function AuthLayout() {
  return (
    <Stack screenOptions={SCREEN_OPTIONS}>
      <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
      <Stack.Screen name="check-email" options={{ title: 'Check your email' }} />
      <Stack.Screen name="age-gate" options={AGE_GATE} />
    </Stack>
  );
}
