# Band amplifier routing regression

Four-layer RF fixture for the public routing DSL. It checks canonical layer
names, stack-driven 50-ohm microstrip compilation, an inner GND reference
plane, and a two-sided GND via fence generated from retained RF tracks.

Run with `node tests/e2e/band_amp/run.mjs` after building the router package
and the local KiCad copilot host.
