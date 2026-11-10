# The native proving outputs are machine-generated per circuit build and git-ignored, so every iOS build - development, bench and bench-device - needs `pnpm circuits:native ios` run first on a macOS host with Xcode 16.4.
# The JS layer's isProverAvailable() === false only covers builds that do not include this module at all (Expo Go, web), so fail here, at pod install / expo prebuild, with that instruction rather than later with an unresolved symbol.
ios_dir = __dir__
required_outputs = ['Frameworks/MoproBindings.xcframework', 'Generated/mopro.swift']
missing_outputs = required_outputs.reject { |path| File.exist?(File.join(ios_dir, path)) }

unless missing_outputs.empty?
  raise "TablemateProver is missing #{missing_outputs.join(', ')} in " \
        'apps/mobile/modules/tablemate-prover/ios. Run `pnpm circuits:native ios` on a macOS host ' \
        'with Xcode 16.4 to generate them (`pnpm circuits:compile` must have produced the circuit ' \
        'artefacts first).'
end

Pod::Spec.new do |s|
  s.name = 'TablemateProver'
  s.version = '0.1.0'
  s.summary = 'On-device Groth16 prover for Tablemate (mopro, rust-witness, rapidsnark).'
  s.description = 'Native witness generation, Groth16 proving and streaming file hashing for the Tablemate itinerary circuit.'
  s.author = 'Tablemate'
  s.homepage = 'https://docs.expo.dev/modules/'
  # The app ships iOS, Android and web: there is no tvOS target, and iOS 16.0 is the project floor.
  s.platforms = { :ios => '16.0' }
  # Swift 5 language mode, so the generated uniffi bindings compile without Swift 6 strict-concurrency errors.
  # SWIFT_VERSION takes a language mode, not a compiler version: Xcode 16.4 (Swift 6.1) accepts only 4.0, 4.2, 5.0 and 6.0, and CocoaPods writes this value through verbatim, so '5.9' failed the pod's own build with `error: SWIFT_VERSION '5.9' is unsupported, supported versions are: 4.0, 4.2, 5.0, 6.0`.
  s.swift_version = '5.0'
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'

  s.source_files = ['*.swift', 'Generated/**/*.swift']
  s.vendored_frameworks = 'Frameworks/MoproBindings.xcframework'

  # The Rust targets are aarch64-apple-ios and aarch64-apple-ios-sim only, so the vendored framework has no x86_64 simulator slice.
  # Simulator builds that compile every architecture (the bench profile) would otherwise fail to link, so x86_64 is excluded for that SDK alone; Intel-Mac simulators are therefore unsupported.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64'
  }
  s.user_target_xcconfig = {
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64'
  }
end
