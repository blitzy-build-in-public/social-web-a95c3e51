/** The auth route group: sign-in, check-email and the age gate in one stack (AAP 0.5.8). */
import { Stack } from 'expo-router';
import { colors, fontWeights, typography } from '@tablemate/shared';
const SCREEN_OPTIONS = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.text,
  headerTitleStyle: { fontSize: typography.title.fontSize, fontWeight: fontWeights.bold },
  contentStyle: { backgroundColor: colors.background },
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
