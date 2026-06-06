/**
 * @module routes/content
 * @description Tier-gated content endpoints for the AgreeStellar.
 *
 * `attachTier` runs globally in index.js, so `req.user.tier` is always
 * populated before any handler here runs.
 *
 * Endpoint summary:
 *
 *   GET /content                 List all content; items above the user's
 *                                tier are returned as censored previews.
 *
 *   GET /content/tier-status     Current user's tier info + upgrade hints.
 *                                Frontend uses this to render upgrade UI.
 *
 *   GET /content/:id             Single item — full or censored depending
 *                                on the user's tier vs the content's tier.
 *
 *   GET /content/tier/bronze     All bronze-tier content (requires bronze+)
 *   GET /content/tier/silver     All silver-tier content (requires silver+)
 *   GET /content/tier/gold       All gold-tier content  (requires gold)
 */

const express = require('express');
const router = express.Router();
const contentService = require('../services/contentService');
const { authenticateToken, requireTierUnified, getUserId } = require('../middleware/unifiedAuth');

// Get content by ID with tier-based filtering
router.get('/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const content = contentService.getContent(contentId, getUserId(req.user));
    
    res.json({
      success: true,
      content
    });

const { requireTier } = require('../middleware/tierAuth');
const tierService = require('../services/tierService');
const contentService = require('../services/contentService');

// ── Open endpoints (tier filtering applied inside, not at the gate) ─────────

/**
 * GET /content
 *
 * Returns every content item the platform has.
 * - Items the user can access: returned in full with `locked: false`
 * - Items above the user's tier: returned as censored previews with
 *   `locked: true`, `contentUrl: null`, and an `upgrade` hint string.
 *
 * This lets the frontend show a unified catalogue where locked items
 * are visually greyed out but still discoverable.
 */
router.get('/', async (req, res) => {
  try {
    const filters = {
      creator: req.query.creator,
      tier: req.query.tier,
      tags: req.query.tags ? req.query.tags.split(',') : undefined,
      userAddress: getUserId(req.user),
      search: req.query.search
    };

    const contentList = contentService.listContent(getUserId(req.user), filters);
    
    res.json({
      success: true,
      tier: userTier,
      total: filtered.length,
      unlocked: filtered.filter((i) => !i.locked).length,
      locked: filtered.filter((i) => i.locked).length,
      items: filtered,
    });
  } catch (err) {
    console.error('[content] GET / error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch content' });
  }
});

// Create new content (creator only)
router.post('/', authenticateToken, requireTierUnified('bronze'), (req, res) => {
  try {
    const {
      title,
      description,
      requiredTier = 'bronze',
      thumbnail,
      duration,
      price,
      tags
    } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        success: false,
        error: 'Title and description are required'
      });
    }

    const content = contentService.addContent({
      title,
      description,
      requiredTier,
      thumbnail,
      duration: parseFloat(duration),
      price,
      tags: tags || []
    }, getUserId(req.user));

    res.status(201).json({
      success: true,
      content
    });

  } catch (error) {
    console.error('Create content error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create content'
    });
  }
});

// Update content (creator only)
router.put('/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const updates = req.body;

    // Don't allow updating creator or creation date
    delete updates.creator;
    delete updates.createdAt;

    const updatedContent = contentService.updateContent(contentId, updates, getUserId(req.user));
    
    res.json({
      success: true,
      content: updatedContent
    });

/**
 * GET /content/tier/bronze
 * Returns only bronze-tier content. Requires bronze subscription or above.
 * Guests receive a 403 with an upgrade suggestion.
 */
router.get('/tier/bronze', requireTier('bronze'), async (req, res) => {
  try {
    const { contentId } = req.params;
    
    contentService.deleteContent(contentId, getUserId(req.user));
    
    res.json({
      success: true,
      message: 'Content deleted successfully'
    });

  } catch (error) {
    console.error('Delete content error:', error);
    res.status(403).json({
      success: false,
      error: error.message || 'Failed to delete content'
    });
  }
});

/**
 * GET /content/tier/silver
 * Returns only silver-tier content. Requires silver subscription or above.
 */
router.get('/tier/silver', requireTier('silver'), async (req, res) => {
  try {
    const { contentId } = req.params;
    const canAccess = contentService.canAccessContent(contentId, getUserId(req.user));
    
    res.json({
      success: true,
      contentId,
      canAccess,
      userTier: contentService.getUserTier(getUserId(req.user))
    });

  } catch (error) {
    console.error('Check access error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check access'
    });
  }
});

/**
 * GET /content/tier/gold
 * Returns only gold-tier content. Requires gold subscription.
 */
router.get('/tier/gold', requireTier('gold'), async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const stats = contentService.getCreatorStats(creatorAddress, getUserId(req.user));
    
    res.json({
      success: true,
      creatorAddress,
      stats
    });

  } catch (error) {
    console.error('Get creator stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get creator statistics'
    });
  }
});

// ── Single-item endpoint (must come after /tier/* routes) ───────────────────

/**
 * GET /content/:id
 *
 * Returns a single content item by ID.
 *
 * - If the user's tier meets the content requirement: full item returned.
 * - If the user's tier is too low: 403 with a censored preview so the
 *   frontend can still render something meaningful (thumbnail, title,
 *   truncated description, upgrade suggestion).
 *
 * IMPORTANT: this route is defined AFTER /tier-status and /tier/* so
 * Express does not accidentally match those paths as :id values.
 */
router.get('/:id', async (req, res) => {
  try {
    const suggestions = contentService.getUpgradeSuggestions(getUserId(req.user));
    
    res.json({
      success: true,
      suggestions
    });

  } catch (error) {
    console.error('Get upgrade suggestions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get upgrade suggestions'
    });
  }
});

    if (!content) {
      return res.status(404).json({ success: false, error: 'Content not found' });
    }

    const filters = {
      ...req.query,
      requiredTier: tierName,
      userAddress: getUserId(req.user)
    };

    const contentList = contentService.listContent(getUserId(req.user), filters);
    
    res.json({
      success: true,
      tier: tierName,
      content: contentList,
      count: contentList.length
    });

  } catch (error) {
    console.error('Get content by tier error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get content by tier'
    });
  }
});

// Search content with tier awareness
router.post('/search', authenticateToken, (req, res) => {
  try {
    const { query, filters = {} } = req.body;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient subscription tier',
        required: content.tier,
        current: userTier,
        preview: tierService.censorContent(content, userTier),
      });
    }

    const searchFilters = {
      ...filters,
      search: query,
      userAddress: getUserId(req.user)
    };

    const results = contentService.listContent(getUserId(req.user), searchFilters);
    
    res.json({
      success: true,
      query,
      filters,
      userAddress: getUserId(req.user),
      results,
      count: results.length
    });

  } catch (error) {
    console.error('Search content error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search content'
    });
  }
});

// Get user's accessible content summary
router.get('/user/summary', authenticateToken, (req, res) => {
  try {
    const userTier = contentService.getUserTier(getUserId(req.user));
    const allContent = contentService.listContent(getUserId(req.user));
    
    const summary = {
      userTier,
      totalContent: allContent.length,
      accessibleContent: allContent.filter(c => !c.censored).length,
      restrictedContent: allContent.filter(c => c.censored).length,
      contentByTier: {
        bronze: allContent.filter(c => c.requiredTier === 'bronze').length,
        silver: allContent.filter(c => c.requiredTier === 'silver').length,
        gold: allContent.filter(c => c.requiredTier === 'gold').length
      }
    };

    res.json({
      success: true,
      summary
    });

  } catch (error) {
    console.error('Get user summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user summary'
    });
  }
});

module.exports = router;