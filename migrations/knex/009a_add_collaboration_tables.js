exports.up = function(knex) {
  return knex.schema
    // Content collaborations table
    .createTable('content_collaborations', function(table) {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('content_id').notNullable().references('id').inTable('content').onDelete('CASCADE');
      table.string('primary_creator_address').notNullable().index();
      table.enum('status', ['active', 'inactive', 'completed']).defaultTo('active').index();
      table.integer('total_watch_seconds').defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      // Indexes for performance
      table.index(['primary_creator_address', 'status']);
      table.index(['content_id']);
      table.index(['status', 'created_at']);
    })
    
    // Collaboration participants table
    .createTable('collaboration_participants', function(table) {
      table.string('collaboration_id').notNullable().references('id').inTable('content_collaborations').onDelete('CASCADE');
      table.string('creator_address').notNullable().index();
      table.decimal('split_ratio', 5, 4).notNullable(); // Split ratio (0.0000 to 1.0000)
      table.enum('role', ['primary', 'collaborator']).notNullable().defaultTo('collaborator');
      table.integer('watch_seconds').defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      // Indexes for performance
      table.index(['collaboration_id', 'creator_address']);
      table.index(['creator_address', 'role']);
      table.index(['collaboration_id', 'role']);
      
      // Unique constraint: one participant per address per collaboration
      table.unique(['collaboration_id', 'creator_address']);
    })
    
    // Collaboration watch logs table
    .createTable('collaboration_watch_logs', function(table) {
      table.string('collaboration_id').notNullable().references('id').inTable('content_collaborations').onDelete('CASCADE');
      table.string('user_address').notNullable().index();
      table.integer('watch_seconds').notNullable();
      table.timestamp('first_watched_at').defaultTo(knex.fn.now());
      table.timestamp('last_watched_at').defaultTo(knex.fn.now());
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      // Indexes for performance
      table.index(['collaboration_id', 'user_address']);
      table.index(['user_address', 'last_watched_at']);
      table.index(['collaboration_id', 'last_watched_at']);
      
      // Unique constraint: one record per user per collaboration
      table.unique(['collaboration_id', 'user_address']);
    })
    
    // Revenue attribution logs table
    .createTable('revenue_attribution_logs', function(table) {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('collaboration_id').notNullable().references('id').inTable('content_collaborations').onDelete('CASCADE');
      table.string('period_start').notNullable();
      table.string('period_end').notNullable();
      table.decimal('total_revenue', 20, 8).notNullable();
      table.string('currency').notNullable().defaultTo('XLM');
      table.integer('total_watch_seconds').notNullable();
      table.json('attribution_data').notNullable(); // Detailed attribution breakdown
      table.string('verification_status').defaultTo('pending'); // pending, verified, failed
      table.text('verification_details');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('verified_at');
      
      // Indexes for performance
      table.index(['collaboration_id', 'period_start']);
      table.index(['verification_status']);
      table.index(['created_at']);
    })
    
    // Update content table to support collaborations
    .table('content', function(table) {
      table.boolean('is_collaborative').defaultTo(false);
      table.string('collaboration_id').references('id').inTable('content_collaborations').onDelete('SET NULL');
      table.timestamp('collaboration_updated_at');
      
      // Add index for collaborative content queries
      table.index(['is_collaborative']);
      table.index(['collaboration_id']);
    })
    
    // Update creators table to track collaboration stats
    .table('creators', function(table) {
      table.integer('total_collaborations').defaultTo(0);
      table.integer('collaborator_count').defaultTo(0);
      table.decimal('total_collaboration_revenue', 20, 8).defaultTo(0);
      table.timestamp('collaboration_stats_updated_at');
      
      // Add index for collaboration stats
      table.index(['total_collaborations']);
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('revenue_attribution_logs')
    .dropTableIfExists('collaboration_watch_logs')
    .dropTableIfExists('collaboration_participants')
    .dropTableIfExists('content_collaborations')
    .table('content', function(table) {
      table.dropColumn('is_collaborative');
      table.dropColumn('collaboration_id');
      table.dropColumn('collaboration_updated_at');
    })
    .table('creators', function(table) {
      table.dropColumn('total_collaborations');
      table.dropColumn('collaborator_count');
      table.dropColumn('total_collaboration_revenue');
      table.dropColumn('collaboration_stats_updated_at');
    });
};
