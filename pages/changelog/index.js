const {createArticleReader}=require('../../utils/article-reader');
Page(createArticleReader({serviceName:'manageChangelog',cachePrefix:'changelog',changelog:true}));
