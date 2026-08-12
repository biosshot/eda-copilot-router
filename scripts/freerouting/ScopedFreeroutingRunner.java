package app.freerouting.workflow;

import app.freerouting.Freerouting;
import app.freerouting.autoroute.BatchAutorouter;
import app.freerouting.autoroute.BatchOptimizer;
import app.freerouting.autoroute.BoardUpdateStrategy;
import app.freerouting.autoroute.ItemSelectionStrategy;
import app.freerouting.board.ItemIdentificationNumberGenerator;
import app.freerouting.core.RoutingJob;
import app.freerouting.core.RoutingJobState;
import app.freerouting.core.StoppableThread;
import app.freerouting.core.scoring.BoardStatistics;
import app.freerouting.io.BoardReadResult;
import app.freerouting.management.HeadlessBoardManager;
import app.freerouting.rules.NetClass;
import app.freerouting.settings.GlobalSettings;
import app.freerouting.settings.RouterSettings;
import app.freerouting.settings.SettingsMerger;
import app.freerouting.settings.sources.DefaultSettings;
import app.freerouting.settings.sources.DsnFileSettings;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryPoolMXBean;

/**
 * Small headless Freerouting launcher with exact ignored-net-class handling.
 *
 * Freerouting parses -inc into RouterSettings but applies it only from
 * GuiManager. This runner deliberately sets the loaded board's NetClass flags,
 * disables the unscoped fanout pre-pass, and keeps the router itself upstream.
 */
public final class ScopedFreeroutingRunner {
  private static final String VERSION = "workflow-scoped-runner/1";

  private ScopedFreeroutingRunner() {}

  private static final class Arguments {
    Path input;
    Path output;
    final Set<String> ignoredClasses = new LinkedHashSet<>();
    int maxPasses = 100;
    int threads = 1;
    boolean optimize = true;
    int optimizerMaxPasses = 100;
    float optimizerThreshold = 0.001f;
    BoardUpdateStrategy updateStrategy = BoardUpdateStrategy.HYBRID;
    ItemSelectionStrategy itemStrategy = ItemSelectionStrategy.PRIORITIZED;
  }

  private static final class RunnerThread extends StoppableThread {
    @Override
    protected void thread_action() {}
  }

  public static void main(String[] rawArgs) {
    try {
      Arguments args = parse(rawArgs);
      run(args);
    } catch (Throwable error) {
      error.printStackTrace(System.err);
      System.exit(1);
    }
  }

  private static Arguments parse(String[] values) {
    Arguments result = new Arguments();
    for (int i = 0; i < values.length; i++) {
      String flag = values[i];
      switch (flag) {
        case "--input" -> result.input = Path.of(requireValue(values, ++i, flag)).toAbsolutePath();
        case "--output" -> result.output = Path.of(requireValue(values, ++i, flag)).toAbsolutePath();
        case "--ignore-class" -> result.ignoredClasses.add(requireValue(values, ++i, flag));
        case "--max-passes" -> result.maxPasses = positiveInt(requireValue(values, ++i, flag), flag);
        case "--threads" -> result.threads = positiveInt(requireValue(values, ++i, flag), flag);
        case "--optimizer-max-passes" -> result.optimizerMaxPasses = positiveInt(requireValue(values, ++i, flag), flag);
        case "--optimizer-threshold" -> result.optimizerThreshold = positiveFloat(requireValue(values, ++i, flag), flag);
        case "--update-strategy" -> result.updateStrategy = updateStrategy(requireValue(values, ++i, flag));
        case "--item-strategy" -> result.itemStrategy = itemStrategy(requireValue(values, ++i, flag));
        case "--no-optimizer" -> result.optimize = false;
        default -> throw new IllegalArgumentException("Unknown argument: " + flag);
      }
    }
    if (result.input == null || result.output == null) {
      throw new IllegalArgumentException("--input and --output are required");
    }
    if (result.ignoredClasses.isEmpty()) {
      throw new IllegalArgumentException("At least one --ignore-class is required");
    }
    if (!Files.isRegularFile(result.input)) {
      throw new IllegalArgumentException("Input DSN does not exist: " + result.input);
    }
    if (result.input.equals(result.output)) {
      throw new IllegalArgumentException("Input and output must be different files");
    }
    return result;
  }

  private static String requireValue(String[] values, int index, String flag) {
    if (index >= values.length) throw new IllegalArgumentException("Missing value after " + flag);
    return values[index];
  }

  private static int positiveInt(String value, String flag) {
    int result = Integer.parseInt(value);
    if (result <= 0) throw new IllegalArgumentException(flag + " must be positive");
    return result;
  }

  private static float positiveFloat(String value, String flag) {
    float result = Float.parseFloat(value);
    if (!Float.isFinite(result) || result <= 0) throw new IllegalArgumentException(flag + " must be positive");
    return result;
  }

  private static BoardUpdateStrategy updateStrategy(String value) {
    return switch (value.toLowerCase(Locale.ROOT)) {
      case "greedy" -> BoardUpdateStrategy.GREEDY;
      case "global", "global_optimal" -> BoardUpdateStrategy.GLOBAL_OPTIMAL;
      case "hybrid" -> BoardUpdateStrategy.HYBRID;
      default -> throw new IllegalArgumentException("Unsupported update strategy: " + value);
    };
  }

  private static ItemSelectionStrategy itemStrategy(String value) {
    return switch (value.toLowerCase(Locale.ROOT)) {
      case "sequential" -> ItemSelectionStrategy.SEQUENTIAL;
      case "random" -> ItemSelectionStrategy.RANDOM;
      case "prioritized" -> ItemSelectionStrategy.PRIORITIZED;
      default -> throw new IllegalArgumentException("Unsupported item strategy: " + value);
    };
  }

  private static void run(Arguments args) throws Exception {
    Freerouting.globalSettings = new GlobalSettings();
    Freerouting.globalSettings.version = VERSION;

    RoutingJob job = new RoutingJob(UUID.randomUUID());
    job.setInput(args.input.toFile());
    job.tryToSetOutputFile(args.output.toFile());
    job.thread = new RunnerThread();
    job.state = RoutingJobState.RUNNING;

    HeadlessBoardManager boardManager = new HeadlessBoardManager(job);
    try (FileInputStream input = new FileInputStream(args.input.toFile())) {
      BoardReadResult loaded = boardManager.loadFromSpecctraDsn(
          input, null, new ItemIdentificationNumberGenerator());
      if (loaded instanceof BoardReadResult.ParseError || loaded instanceof BoardReadResult.IoError) {
        throw new IllegalStateException("Freerouting could not load the input DSN");
      }
    }
    job.board = boardManager.get_routing_board();
    if (job.board == null) throw new IllegalStateException("Freerouting produced no RoutingBoard");

    try (FileInputStream input = new FileInputStream(args.input.toFile())) {
      SettingsMerger settings = new SettingsMerger(
          new DefaultSettings(), new DsnFileSettings(input, args.input.getFileName().toString()));
      job.routerSettings = settings.merge();
    }
    configure(job.routerSettings, args);
    job.routerSettings.applyBoardSpecificOptimizations(job.board);

    List<String> missingClasses = applyIgnoredClasses(job, args.ignoredClasses);
    if (!missingClasses.isEmpty()) {
      throw new IllegalArgumentException("Ignored net class(es) missing from DSN: " + String.join(", ", missingClasses));
    }

    int initialUnrouted = new BoardStatistics(job.board).connections.incompleteCount;
    MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
    long peakHeapBytes = heapPeakBytes(memory);
    BatchAutorouter autorouter = new BatchAutorouter(job);
    autorouter.runBatchLoop();
    peakHeapBytes = Math.max(peakHeapBytes, heapPeakBytes(memory));
    job.board = autorouterBoard(job);

    if (args.optimize && !job.thread.isStopRequested()) {
      BatchOptimizer optimizer = new BatchOptimizer(job);
      optimizer.runBatchLoop();
      peakHeapBytes = Math.max(peakHeapBytes, heapPeakBytes(memory));
    }

    Files.createDirectories(args.output.getParent());
    boardManager.replaceRoutingBoard(job.board);
    try (FileOutputStream output = new FileOutputStream(args.output.toFile())) {
      if (!boardManager.saveAsSpecctraSessionSes(output, job.name)) {
        throw new IllegalStateException("Freerouting could not write the output SES");
      }
    }

    BoardStatistics finalStats = new BoardStatistics(job.board);
    String summary = "{"
        + "\"runner\":\"" + VERSION + "\","
        + "\"initial_unrouted\":" + initialUnrouted + ","
        + "\"final_unrouted\":" + finalStats.connections.incompleteCount + ","
        + "\"violations\":" + finalStats.clearanceViolations.totalCount + ","
        + "\"trace_count\":" + finalStats.items.traceCount + ","
        + "\"via_count\":" + finalStats.items.viaCount + ","
        + "\"peak_heap_mb\":" + (peakHeapBytes / 1048576.0) + ","
        + "\"ignored_classes\":" + jsonArray(args.ignoredClasses)
        + "}";
    System.out.println("WORKFLOW_JSON_SUMMARY: " + summary);
  }

  private static long heapPeakBytes(MemoryMXBean memory) {
    long peak = memory.getHeapMemoryUsage().getUsed();
    for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
      if (pool.getType() == java.lang.management.MemoryType.HEAP && pool.getPeakUsage() != null) {
        peak = Math.max(peak, pool.getPeakUsage().getUsed());
      }
    }
    return peak;
  }

  private static void configure(RouterSettings settings, Arguments args) {
    settings.enabled = true;
    // Freerouting 2.3 defaults to an SMD fanout pre-pass. The workflow owns
    // exact remaining nets only, so fanout must be disabled: it has no ignored
    // net-class filter and would otherwise add copper to KRT special nets.
    if (settings.fanout != null) settings.fanout.enabled = false;
    settings.maxPasses = args.maxPasses;
    settings.maxThreads = args.threads;
    settings.optimizer.enabled = args.optimize;
    settings.optimizer.maxPasses = args.optimizerMaxPasses;
    settings.optimizer.maxThreads = args.threads;
    settings.optimizer.optimizationImprovementThreshold = args.optimizerThreshold;
    settings.optimizer.boardUpdateStrategy = args.updateStrategy;
    settings.optimizer.itemSelectionStrategy = args.itemStrategy;
    settings.optimizer.hybridRatio = "1:1";
    settings.ignoreNetClasses = args.ignoredClasses.toArray(String[]::new);
  }

  private static List<String> applyIgnoredClasses(RoutingJob job, Set<String> names) {
    List<String> missing = new ArrayList<>();
    for (String name : names) {
      NetClass netClass = job.board.rules.net_classes.get(name);
      if (netClass == null) missing.add(name);
      else netClass.is_ignored_by_autorouter = true;
    }
    return missing;
  }

  private static app.freerouting.board.RoutingBoard autorouterBoard(RoutingJob job) {
    if (job.board == null) throw new IllegalStateException("Autorouter lost the RoutingBoard");
    return job.board;
  }

  private static String jsonArray(Set<String> values) {
    StringBuilder result = new StringBuilder("[");
    boolean first = true;
    for (String value : values) {
      if (!first) result.append(',');
      first = false;
      result.append('"').append(value.replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
    }
    return result.append(']').toString();
  }
}
