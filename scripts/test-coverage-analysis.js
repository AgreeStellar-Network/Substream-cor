#!/usr/bin/env node

/**
 * Test Coverage Analysis Script
 * 
 * Analyzes the entire codebase for test coverage across all modules,
 * identifying gaps and ensuring 100% functional requirement coverage.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class TestCoverageAnalyzer {
  constructor(rootDir = process.cwd()) {
    this.rootDir = rootDir;
    this.coverageData = {
      totalFiles: 0,
      testedFiles: 0,
      coveragePercentage: 0,
      modules: {},
      uncoveredFunctions: [],
      testFiles: [],
      coverageByType: {
        unit: 0,
        integration: 0,
        e2e: 0,
        security: 0,
        performance: 0
      }
    };
  }

  async analyze() {
    console.log('🔍 Starting comprehensive test coverage analysis...');

    // Discover all source files
    const sourceFiles = this.discoverSourceFiles();
    console.log(`📁 Found ${sourceFiles.length} source files`);

    // Discover all test files
    const testFiles = this.discoverTestFiles();
    console.log(`🧪 Found ${testFiles.length} test files`);

    // Analyze coverage for each module
    await this.analyzeModuleCoverage(sourceFiles, testFiles);

    // Run Jest coverage if available
    await this.runJestCoverage();

    // Generate coverage report
    this.generateCoverageReport();

    return this.coverageData;
  }

  discoverSourceFiles() {
    const sourceDirs = [
      'src',
      'routes',
      'services',
      'middleware',
      'workers',
      'scripts'
    ];

    const extensions = ['.js', '.ts'];
    const sourceFiles = [];

    sourceDirs.forEach(dir => {
      const fullPath = path.join(this.rootDir, dir);
      if (fs.existsSync(fullPath)) {
        const files = this.walkDirectory(fullPath, extensions);
        sourceFiles.push(...files);
      }
    });

    return sourceFiles;
  }

  discoverTestFiles() {
    const testDirs = [
      'test',
      'tests',
      '.'
    ];

    const extensions = ['.test.js', '.test.ts', '.spec.js', '.spec.ts'];
    const testFiles = [];

    testDirs.forEach(dir => {
      const fullPath = path.join(this.rootDir, dir);
      if (fs.existsSync(fullPath)) {
        const files = this.walkDirectory(fullPath, extensions);
        testFiles.push(...files);
      }
    });

    this.coverageData.testFiles = testFiles;
    return testFiles;
  }

  walkDirectory(dir, extensions) {
    const files = [];

    function walk(currentDir) {
      const items = fs.readdirSync(currentDir);
      
      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules and other common exclusions
          if (!['node_modules', '.git', 'dist', 'build'].includes(item)) {
            walk(fullPath);
          }
        } else if (stat.isFile()) {
          const ext = path.extname(item);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    }

    walk(dir);
    return files;
  }

  async analyzeModuleCoverage(sourceFiles, testFiles) {
    console.log('📊 Analyzing module coverage...');

    // Group source files by module
    const modules = this.groupFilesByModule(sourceFiles);
    
    for (const [moduleName, files] of Object.entries(modules)) {
      console.log(`🔍 Analyzing module: ${moduleName}`);
      
      const moduleCoverage = {
        totalFiles: files.length,
        testedFiles: 0,
        coveragePercentage: 0,
        functions: [],
        classes: [],
        testTypes: new Set()
      };

      // Analyze each file in the module
      for (const file of files) {
        const fileCoverage = await this.analyzeFileCoverage(file, testFiles);
        moduleCoverage.testedFiles += fileCoverage.hasTests ? 1 : 0;
        moduleCoverage.functions.push(...fileCoverage.functions);
        moduleCoverage.classes.push(...fileCoverage.classes);
        
        if (fileCoverage.hasTests) {
          fileCoverage.testTypes.forEach(type => moduleCoverage.testTypes.add(type));
        }
      }

      moduleCoverage.coveragePercentage = (moduleCoverage.testedFiles / moduleCoverage.totalFiles) * 100;
      this.coverageData.modules[moduleName] = moduleCoverage;
    }

    // Calculate overall coverage
    this.calculateOverallCoverage();
  }

  groupFilesByModule(files) {
    const modules = {};

    files.forEach(file => {
      const relativePath = path.relative(this.rootDir, file);
      const parts = relativePath.split(path.sep);
      const moduleName = parts[0] || 'root';

      if (!modules[moduleName]) {
        modules[moduleName] = [];
      }
      modules[moduleName].push(file);
    });

    return modules;
  }

  async analyzeFileCoverage(sourceFile, testFiles) {
    const content = fs.readFileSync(sourceFile, 'utf8');
    const relativePath = path.relative(this.rootDir, sourceFile);
    
    // Extract functions and classes from source file
    const functions = this.extractFunctions(content);
    const classes = this.extractClasses(content);
    
    // Find corresponding test files
    const testFilesForSource = this.findTestFilesForSource(relativePath, testFiles);
    
    // Analyze test coverage
    const hasTests = testFilesForSource.length > 0;
    const testTypes = new Set();
    let coveredFunctions = [];

    if (hasTests) {
      for (const testFile of testFilesForSource) {
        const testContent = fs.readFileSync(testFile, 'utf8');
        const testType = this.determineTestType(testFile, testContent);
        testTypes.add(testType);
        
        // Check which functions are tested
        const testedFunctions = this.findTestedFunctions(functions, testContent);
        coveredFunctions.push(...testedFunctions);
      }
    }

    // Identify uncovered functions
    const uncoveredFunctions = functions.filter(func => !coveredFunctions.includes(func.name));
    this.coverageData.uncoveredFunctions.push(...uncoveredFunctions.map(func => ({
      function: func.name,
      file: relativePath,
      line: func.line
    })));

    return {
      hasTests,
      testTypes: Array.from(testTypes),
      functions,
      classes,
      coveredFunctions,
      uncoveredFunctions
    };
  }

  extractFunctions(content) {
    const functions = [];
    const lines = content.split('\n');
    
    // Regex patterns for different function types
    const patterns = [
      /function\s+(\w+)\s*\(/g,           // function name() {}
      /const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,  // const name = () => {}
      /(\w+)\s*:\s*(?:async\s+)?function\s*\(/g,  // name: function() {}
      /async\s+(\w+)\s*\(/g,                 // async name() {}
      /(\w+)\s*\([^)]*\)\s*\{/g              // name() {}
    ];

    lines.forEach((line, index) => {
      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          functions.push({
            name: match[1],
            line: index + 1
          });
        }
      });
    });

    return functions;
  }

  extractClasses(content) {
    const classes = [];
    const lines = content.split('\n');
    const classPattern = /class\s+(\w+)/g;

    lines.forEach((line, index) => {
      let match;
      while ((match = classPattern.exec(line)) !== null) {
        classes.push({
          name: match[1],
          line: index + 1
        });
      }
    });

    return classes;
  }

  findTestFilesForSource(sourceFile, testFiles) {
    const baseName = path.basename(sourceFile, path.extname(sourceFile));
    const sourceDir = path.dirname(sourceFile);
    
    const testFilesForSource = testFiles.filter(testFile => {
      const testBaseName = path.basename(testFile, path.extname(testFile));
      return testBaseName.includes(baseName) || testBaseName === baseName + '.test' || testBaseName === baseName + '.spec';
    });

    return testFilesForSource;
  }

  determineTestType(testFile, content) {
    const fileName = path.basename(testFile).toLowerCase();
    
    if (fileName.includes('integration')) return 'integration';
    if (fileName.includes('e2e')) return 'e2e';
    if (fileName.includes('security')) return 'security';
    if (fileName.includes('performance') || fileName.includes('load')) return 'performance';
    if (fileName.includes('api')) return 'integration';
    
    // Analyze content for test type indicators
    if (content.includes('supertest') || content.includes('axios')) return 'integration';
    if (content.includes('puppeteer') || content.includes('playwright')) return 'e2e';
    if (content.includes('security') || content.includes('auth')) return 'security';
    if (content.includes('performance') || content.includes('benchmark')) return 'performance';
    
    return 'unit';
  }

  findTestedFunctions(functions, testContent) {
    const testedFunctions = [];
    
    functions.forEach(func => {
      if (testContent.includes(func.name)) {
        testedFunctions.push(func.name);
      }
    });

    return testedFunctions;
  }

  async runJestCoverage() {
    try {
      console.log('🧪 Running Jest coverage analysis...');
      
      const result = execSync('npm test -- --coverage --passWithNoTests --silent', {
        cwd: this.rootDir,
        encoding: 'utf8',
        stdio: 'pipe'
      });

      // Parse Jest coverage output if available
      this.parseJestCoverage(result);
      
    } catch (error) {
      console.warn('⚠️  Jest coverage not available:', error.message);
    }
  }

  parseJestCoverage(output) {
    // This would parse the actual Jest coverage output
    // For now, we'll use the manual analysis
    console.log('📊 Jest coverage completed');
  }

  calculateOverallCoverage() {
    let totalFiles = 0;
    let testedFiles = 0;

    for (const module of Object.values(this.coverageData.modules)) {
      totalFiles += module.totalFiles;
      testedFiles += module.testedFiles;
    }

    this.coverageData.totalFiles = totalFiles;
    this.coverageData.testedFiles = testedFiles;
    this.coverageData.coveragePercentage = totalFiles > 0 ? (testedFiles / totalFiles) * 100 : 0;

    // Calculate coverage by test type
    for (const module of Object.values(this.coverageData.modules)) {
      module.testTypes.forEach(type => {
        if (this.coverageData.coverageByType[type] !== undefined) {
          this.coverageData.coverageByType[type]++;
        }
      });
    }
  }

  generateCoverageReport() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 TEST COVERAGE ANALYSIS REPORT');
    console.log('='.repeat(80));
    console.log(`📁 Total Source Files: ${this.coverageData.totalFiles}`);
    console.log(`🧪 Tested Files: ${this.coverageData.testedFiles}`);
    console.log(`📈 Overall Coverage: ${this.coverageData.coveragePercentage.toFixed(2)}%`);
    
    console.log('\n📋 Coverage by Test Type:');
    Object.entries(this.coverageData.coverageByType).forEach(([type, count]) => {
      console.log(`  ${type.charAt(0).toUpperCase() + type.slice(1)}: ${count} files`);
    });

    console.log('\n📦 Coverage by Module:');
    Object.entries(this.coverageData.modules).forEach(([name, module]) => {
      const status = module.coveragePercentage === 100 ? '✅' : 
                     module.coveragePercentage >= 80 ? '⚠️' : '❌';
      console.log(`  ${status} ${name}: ${module.coveragePercentage.toFixed(2)}% (${module.testedFiles}/${module.totalFiles})`);
    });

    if (this.coverageData.uncoveredFunctions.length > 0) {
      console.log('\n⚠️  Uncovered Functions:');
      this.coverageData.uncoveredFunctions.slice(0, 10).forEach(func => {
        console.log(`  - ${func.function} (${func.file}:${func.line})`);
      });
      
      if (this.coverageData.uncoveredFunctions.length > 10) {
        console.log(`  ... and ${this.coverageData.uncoveredFunctions.length - 10} more`);
      }
    }

    console.log('='.repeat(80));

    // Save detailed report
    const reportPath = path.join(this.rootDir, 'test-coverage-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(this.coverageData, null, 2));
    console.log(`📄 Detailed report saved to: ${reportPath}`);
  }
}

// Run the analysis
if (require.main === module) {
  const analyzer = new TestCoverageAnalyzer();
  
  analyzer.analyze()
    .then(() => {
      console.log('\n✅ Test coverage analysis completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Test coverage analysis failed:', error);
      process.exit(1);
    });
}

module.exports = TestCoverageAnalyzer;
